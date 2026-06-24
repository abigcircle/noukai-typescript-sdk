/**
 * Phase 8: Next.js App Router adapter tests.
 *
 * Tests use minimal in-process mocks of the Web Fetch API Request/Response,
 * which are available natively in Node 18+ (required by the SDK). No hard
 * dependency on the `next` package.
 *
 * Scenario 8 coverage: capture mode sets X-Noukai-Session on the returned Response.
 * Additional coverage: replay mode activation, error → HTTP status mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Noukai } from "../../src/index.js";
import { withNoukaiTrace } from "../../src/adapters/nextjs.js";
import {
  HEADER_REPLAY,
  HEADER_RESPONSE_SESSION,
  HEADER_SESSION_ID,
} from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Global fetch spy
// ---------------------------------------------------------------------------

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

const originalEnv = { ...process.env };
afterEach(() => {
  if (originalEnv.NOUKAI_REPLAY_ENABLED === undefined) {
    delete process.env.NOUKAI_REPLAY_ENABLED;
  } else {
    process.env.NOUKAI_REPLAY_ENABLED = originalEnv.NOUKAI_REPLAY_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract URL string from fetch input. */
function fetchInputToString(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input !== null && input !== undefined && typeof (input as Request).url === "string") {
    return (input as Request).url;
  }
  return String(input);
}

/** Extract lowercase-keyed headers from a fetch RequestInit. */
function headersToRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init?.headers) return out;
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers as [string, string][]) {
      out[k.toLowerCase()] = v;
    }
  } else {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function successExecuteResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      result: { ok: true },
      executionId: "exec-1",
      flowId: "f",
      blockCount: 1,
    }),
    { status: 200 },
  );
}

function sessionResponse(executions: unknown[] = [], sessionId = "11111111-1111-4111-8111-111111111111"): Response {
  return new Response(JSON.stringify({ sessionId, executions }), { status: 200 });
}

function sessionExecution(opts: {
  result?: unknown;
  snapshotsAvailable?: boolean;
} = {}): unknown {
  return {
    executionId: "exec-rec-1",
    flowId: "flow-1",
    slug: "grade-3",
    triggerType: "execute",
    status: "completed",
    startedAt: "2026-06-05T00:00:00Z",
    completedAt: "2026-06-05T00:00:01Z",
    traceCaptureMode: opts.snapshotsAvailable === false ? "off" : "full",
    snapshotsAvailable: opts.snapshotsAvailable !== false,
    steps: [{
      stepId: "s-1", blockId: "b-1", attempt: 1,
      inputSnapshot: {}, outputSnapshot: opts.result ?? { ok: true },
      errorSnapshot: null, truncated: false,
      startedAt: "t", completedAt: "t",
    }],
    errorAtStep: null,
  };
}

/** Build a minimal Web Fetch API Request with optional headers. */
function makeNextRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/route", {
    method: "POST",
    headers,
  });
}

// ---------------------------------------------------------------------------
// Scenario 8: capture mode sets X-Noukai-Session on the returned Response
// ---------------------------------------------------------------------------

describe("Next.js adapter — Phase 8", () => {
  it("8: capture mode sets X-Noukai-Session on returned Response", async () => {
    let outboundSessionId: string | undefined;

    fetchSpy.mockImplementation(async (_input, init) => {
      const headers = headersToRecord(init);
      outboundSessionId = headers[HEADER_SESSION_ID.toLowerCase()];
      return successExecuteResponse();
    });

    const noukai = new Noukai({ apiKey: "nk_test" });

    const handler = withNoukaiTrace(
      async (_req: Request) => {
        await noukai.flow("a/b/c").execute({ message: "hi" });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { client: noukai },
    );

    const req = makeNextRequest();
    const res = await handler(req);

    // Capture mode: response carries X-Noukai-Session.
    const responseSid = res.headers.get(HEADER_RESPONSE_SESSION);
    expect(responseSid).toBeTruthy();

    // The outbound execute request carries the same session id.
    expect(outboundSessionId).toBe(responseSid);
  });

  it("8: Response.json() created by handler gets session header", async () => {
    fetchSpy.mockImplementation(async () => successExecuteResponse());

    const noukai = new Noukai({ apiKey: "nk_test" });

    const handler = withNoukaiTrace(
      async (_req: Request) => {
        await noukai.flow("a/b/c").execute({ message: "hi" });
        // Response.json() creates an immutable response — the adapter clones it.
        return Response.json({ ok: true });
      },
      { client: noukai },
    );

    const req = makeNextRequest();
    const res = await handler(req);

    expect(res.headers.get(HEADER_RESPONSE_SESSION)).toBeTruthy();
    // Body is still accessible after the clone.
    expect(await res.json()).toEqual({ ok: true });
  });

  it("8: multiple requests each get independent session ids", async () => {
    fetchSpy.mockImplementation(async () => successExecuteResponse());

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => {
        await noukai.flow("a/b/c").execute({ message: "hi" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      { client: noukai },
    );

    const responses = await Promise.all([
      handler(makeNextRequest()),
      handler(makeNextRequest()),
      handler(makeNextRequest()),
    ]);

    const sids = responses.map(r => r.headers.get(HEADER_RESPONSE_SESSION));
    expect(sids.every(s => s !== null && s !== "")).toBe(true);
    expect(new Set(sids).size).toBe(3);
  });

  it("8: replay header activates replay mode when NOUKAI_REPLAY_ENABLED=true", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse([sessionExecution({ result: { replayed: true } })]);
      }
      return successExecuteResponse();
    });

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    let capturedResult: unknown;

    const handler = withNoukaiTrace(
      async (_req: Request) => {
        const r = await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        capturedResult = r;
        return new Response(JSON.stringify({ out: r }), { status: 200 });
      },
      { client: noukai },
    );

    const req = makeNextRequest({ [HEADER_REPLAY]: "11111111-1111-4111-8111-111111111111" });
    const res = await handler(req);

    expect(res.status).toBe(200);
    // Result came from replay snapshot.
    expect((capturedResult as { result: { replayed: boolean } }).result).toEqual({ replayed: true });
  });

  it("8: replay header ignored when NOUKAI_REPLAY_ENABLED is unset", async () => {
    delete process.env.NOUKAI_REPLAY_ENABLED;

    const urls: string[] = [];
    fetchSpy.mockImplementation(async (input) => {
      urls.push(fetchInputToString(input));
      return successExecuteResponse();
    });

    const noukai = new Noukai({ apiKey: "nk_test" });

    const handler = withNoukaiTrace(
      async (_req: Request) => {
        await noukai.flow("a/b/c").execute({ message: "hi" });
        return new Response("{}", { status: 200 });
      },
      { client: noukai },
    );

    const req = makeNextRequest({ [HEADER_REPLAY]: "sess-ignored" });
    await handler(req);

    // Live execute was called; no session fetch.
    expect(urls.some(u => u.endsWith("/execute"))).toBe(true);
    expect(urls.some(u => u.includes("/seq/sessions/"))).toBe(false);
  });

  it("403 from session fetch → 403 JSON error response", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ detail: { code: "FORBIDDEN", message: "no access" } }),
        { status: 403 },
      ),
    );

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => new Response("{}", { status: 200 }),
      { client: noukai },
    );

    const req = makeNextRequest({ [HEADER_REPLAY]: "11111111-1111-4111-8111-111111111111" });
    const res = await handler(req);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("replay_forbidden");
  });

  it("404 from session fetch → 404 JSON error response", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ detail: { code: "NOT_FOUND", message: "no session" } }),
        { status: 404 },
      ),
    );

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => new Response("{}", { status: 200 }),
      { client: noukai },
    );

    const req = makeNextRequest({ [HEADER_REPLAY]: "11111111-1111-4111-8111-111111111111" });
    const res = await handler(req);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("replay_session_not_found");
  });

  it("410 from session fetch → 410 JSON error response", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ detail: { code: "GONE", message: "expired" } }),
        { status: 410 },
      ),
    );

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => new Response("{}", { status: 200 }),
      { client: noukai },
    );

    const req = makeNextRequest({ [HEADER_REPLAY]: "11111111-1111-4111-8111-111111111111" });
    const res = await handler(req);

    expect(res.status).toBe(410);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("replay_session_expired");
  });

  it("400 from session fetch → 400 JSON error response", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ detail: { code: "BAD_REQUEST", message: "bad id" } }),
        { status: 400 },
      ),
    );

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => new Response("{}", { status: 200 }),
      { client: noukai },
    );

    const req = makeNextRequest({ [HEADER_REPLAY]: "11111111-1111-4111-8111-111111111111" });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("replay_invalid_session");
  });

  it("non-replay error is re-thrown (not converted to HTTP response)", async () => {
    fetchSpy.mockImplementation(async () => successExecuteResponse());

    const noukai = new Noukai({ apiKey: "nk_test" });

    const handler = withNoukaiTrace(
      async (_req: Request) => {
        throw new Error("handler blew up");
      },
      { client: noukai },
    );

    const req = makeNextRequest();
    await expect(handler(req)).rejects.toThrow("handler blew up");
  });

  it("no replay header → capture mode (no session fetch)", async () => {
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (input) => {
      urls.push(fetchInputToString(input));
      return successExecuteResponse();
    });

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => {
        await noukai.flow("a/b/c").execute({ message: "hi" });
        return new Response("{}", { status: 200 });
      },
      { client: noukai },
    );

    const req = makeNextRequest();
    const res = await handler(req);

    expect(urls.some(u => u.includes("/seq/sessions/"))).toBe(false);
    expect(res.headers.get(HEADER_RESPONSE_SESSION)).toBeTruthy();
  });

  it("handler with no sdk calls still gets session header in capture mode", async () => {
    fetchSpy.mockImplementation(async () => successExecuteResponse());

    const noukai = new Noukai({ apiKey: "nk_test" });
    const handler = withNoukaiTrace(
      async (_req: Request) => new Response(JSON.stringify({ static: true }), { status: 200 }),
      { client: noukai },
    );

    const req = makeNextRequest();
    const res = await handler(req);

    // Even with no SDK calls, the scope was opened so session header is present.
    expect(res.headers.get(HEADER_RESPONSE_SESSION)).toBeTruthy();
  });
});
