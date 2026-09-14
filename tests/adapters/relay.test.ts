/**
 * Flow relay adapter tests (design 20260903-SDK-agent-relay, PR-1).
 *
 * Covers the Express `noukaiRelayHandler` and the Next.js `createRelayRoute`:
 * bounds-before-parse, authorize-before-forward, nk_ bearer injection, and the
 * verbatim relay of the upstream (status, body) including 4xx/5xx and non-JSON.
 *
 * fetch is spied (beforeEach mockReset only — see transport-raise-for-status
 * for why afterEach mockReset is avoided).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Noukai } from "../../src/index.js";
import { APIConnectionError } from "../../src/errors.js";
import { noukaiRelayHandler, type RelayExpressRequest } from "../../src/adapters/express.js";
import { createRelayRoute } from "../../src/adapters/nextjs.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

const PAUSED_BODY = {
  status: "tool_calls_required",
  executionId: "exec-1",
  pausedAtStep: "s1",
  iterationsUsed: 1,
  toolCallMessages: [{ role: "assistant", content: "call" }],
  toolCalls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }],
  accumulatedOutputs: {},
  flowId: "flow-1",
  blockCount: 2,
};
const COMPLETED_BODY = { status: "completed", result: { ok: true }, flowId: "flow-1", blockCount: 2 };

function makeClient(): Noukai {
  // maxRetries: 0 so a reused mock Response is not consumed twice (the TS
  // transport retries 5xx on all methods). Base URL comes from env — assertions
  // check the /seq/... path suffix rather than the host.
  return new Noukai({ apiKey: "nk_test", maxRetries: 0 });
}

const EXECUTE_SUFFIX = /\/seq\/acme\/spelling\/grade-3\/execute$/;

// --- Express mocks ---------------------------------------------------------

function makeExpressReq(raw: string): RelayExpressRequest {
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(raw);
    },
  };
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): void;
}
function makeExpressRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

/** Read lowercase-keyed headers from a fetch RequestInit (Headers or record). */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
}
function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

const allow = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

describe("noukaiRelayHandler (express)", () => {
  it("forwards to the pinned flow's /execute with the nk_ bearer and relays completed verbatim", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "hi" })), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(COMPLETED_BODY);

    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(urlOf(input)).toMatch(EXECUTE_SUFFIX);
    expect(headersOf(init).authorization).toBe("Bearer nk_test");
    expect(JSON.parse(init?.body as string)).toEqual({ message: "hi" });
  });

  it("relays a paused (tool_calls_required) response verbatim", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(PAUSED_BODY), { status: 200 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ messages: [{ role: "user", content: "hi" }] })), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(PAUSED_BODY);
  });

  it.each([400, 402, 409, 413, 500, 503])("relays upstream %i verbatim", async (status) => {
    const errBody = { detail: { code: "TOOLS_NOT_ENABLED", message: "no" } };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(errBody), { status }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "hi" })), res);
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual(errBody);
  });

  it("normalizes a non-JSON upstream body to UPSTREAM_NON_JSON at the upstream status", async () => {
    fetchSpy.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "hi" })), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ detail: "UPSTREAM_NON_JSON" });
  });

  it("rejects an oversized body with 413 BODY_TOO_LARGE before forwarding", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
      bounds: { maxBodyBytes: 16 },
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "x".repeat(500) })), res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ detail: "BODY_TOO_LARGE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects too many messages with 413 TOO_MANY_MESSAGES before forwarding", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
      bounds: { maxMessages: 2 },
    });
    const res = makeExpressRes();
    const body = JSON.stringify({ messages: [1, 2, 3, 4].map((i) => ({ role: "user", content: String(i) })) });
    await handler(makeExpressReq(body), res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ detail: "TOO_MANY_MESSAGES" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400 INVALID_JSON before forwarding", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const res = makeExpressRes();
    await handler(makeExpressReq("{not json"), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ detail: "INVALID_JSON" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authorize rejection blocks the forward (default 403)", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    let seen = false;
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: () => {
        seen = true;
        throw new Error("nope");
      },
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "hi" })), res);
    expect(seen).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 502 UPSTREAM_UNAVAILABLE when the forward hits a connection error", async () => {
    // Reject at the transport layer (not the global fetch spy) — the relay's
    // forward wraps APIConnectionError into a 502. The fetch mock is a defensive
    // no-op (the transport method is stubbed, so fetch is never reached).
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    vi.spyOn(client._transport, "request").mockRejectedValue(
      new APIConnectionError("upstream down"),
    );
    const handler = noukaiRelayHandler({
      client,
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "hi" })), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ detail: "UPSTREAM_UNAVAILABLE" });
  });

  it("honors an authorize error carrying an explicit status/detail", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const handler = noukaiRelayHandler({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: () => {
        throw Object.assign(new Error("not a maker"), { status: 401, detail: "NOT_A_MAKER" });
      },
    });
    const res = makeExpressRes();
    await handler(makeExpressReq(JSON.stringify({ message: "hi" })), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ detail: "NOT_A_MAKER" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------

describe("createRelayRoute (nextjs)", () => {
  it("forwards with the nk_ bearer and relays completed verbatim", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const route = createRelayRoute({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const resp = await route(
      new Request("https://bff.example.com/agent/execute", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(COMPLETED_BODY);

    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(urlOf(input)).toMatch(EXECUTE_SUFFIX);
    expect(headersOf(init).authorization).toBe("Bearer nk_test");
  });

  it("relays upstream 402 verbatim", async () => {
    const errBody = { detail: { code: "INSUFFICIENT_CREDITS", message: "broke" } };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(errBody), { status: 402 }));
    const route = createRelayRoute({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const resp = await route(
      new Request("https://bff.example.com/agent/execute", { method: "POST", body: "{}" }),
    );
    expect(resp.status).toBe(402);
    expect(await resp.json()).toEqual(errBody);
  });

  it("rejects an oversized body via content-length before reading", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const route = createRelayRoute({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
      bounds: { maxBodyBytes: 8 },
    });
    const resp = await route(
      new Request("https://bff.example.com/agent/execute", {
        method: "POST",
        body: JSON.stringify({ message: "x".repeat(500) }),
      }),
    );
    expect(resp.status).toBe(413);
    expect(await resp.json()).toEqual({ detail: "BODY_TOO_LARGE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authorize rejection blocks the forward", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED_BODY), { status: 200 }));
    const route = createRelayRoute({
      client: makeClient(),
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: () => {
        throw Object.assign(new Error("denied"), { statusCode: 403 });
      },
    });
    const resp = await route(
      new Request("https://bff.example.com/agent/execute", { method: "POST", body: "{}" }),
    );
    expect(resp.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 502 UPSTREAM_UNAVAILABLE on a connection error", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    vi.spyOn(client._transport, "request").mockRejectedValue(
      new APIConnectionError("upstream down"),
    );
    const route = createRelayRoute({
      client,
      org: "acme",
      project: "spelling",
      slug: "grade-3",
      authorize: allow,
    });
    const resp = await route(
      new Request("https://bff.example.com/agent/execute", { method: "POST", body: "{}" }),
    );
    expect(resp.status).toBe(502);
    expect(await resp.json()).toEqual({ detail: "UPSTREAM_UNAVAILABLE" });
  });
});
