/**
 * Phase 8: Express middleware adapter tests.
 *
 * Tests use a minimal in-process mock of Express req/res/next to avoid a
 * hard dependency on the `express` package. The middleware only depends on
 * the structural interfaces (MinimalReq, ExtendedRes, NextFn), so the mock
 * faithfully exercises the full code path.
 *
 * Scenario 8 coverage: capture mode sets X-Noukai-Session on the response.
 * Additional coverage: replay mode activation, error → HTTP status mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Noukai } from "../../src/index.js";
import { noukaiTraceMiddleware } from "../../src/adapters/express.js";
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

// Restore env after each test that mutates it.
const originalEnv = { ...process.env };
afterEach(() => {
  if (originalEnv.NOUKAI_REPLAY_ENABLED === undefined) {
    delete process.env.NOUKAI_REPLAY_ENABLED;
  } else {
    process.env.NOUKAI_REPLAY_ENABLED = originalEnv.NOUKAI_REPLAY_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// Minimal Express req/res/next mock
// ---------------------------------------------------------------------------

interface MockReq {
  headers: Record<string, string | string[] | undefined>;
}

interface MockRes {
  statusCode: number;
  responseBody: unknown;
  sentHeaders: Record<string, string>;
  headersSent: boolean;
  writeHeadCalled: boolean;
  setHeader(name: string, value: string): void;
  status(code: number): MockRes;
  json(body: unknown): void;
  writeHead(...args: unknown[]): unknown;
}

function makeMockReq(headers: Record<string, string | string[] | undefined> = {}): MockReq {
  return { headers };
}

function makeMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    responseBody: undefined,
    sentHeaders: {},
    headersSent: false,
    writeHeadCalled: false,
    setHeader(name: string, value: string) {
      res.sentHeaders[name.toLowerCase()] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.responseBody = body;
      res.headersSent = true;
    },
    writeHead(..._args: unknown[]) {
      res.writeHeadCalled = true;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract URL string from fetch input (string | URL | Request). */
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
  executionId?: string;
  slug?: string;
  result?: unknown;
  snapshotsAvailable?: boolean;
} = {}): unknown {
  return {
    executionId: opts.executionId ?? "exec-rec-1",
    flowId: "flow-1",
    // BARE flow.slug per BE wire shape.
    slug: opts.slug ?? "grade-3",
    triggerType: "execute",
    status: "completed",
    startedAt: "2026-06-05T00:00:00Z",
    completedAt: "2026-06-05T00:00:01Z",
    traceCaptureMode: opts.snapshotsAvailable === false ? "off" : "full",
    snapshotsAvailable: opts.snapshotsAvailable !== false,
    steps: [{
      stepId: "s-1", blockId: "b-1", attempt: 1,
      inputSnapshot: { input: "x" }, outputSnapshot: opts.result ?? { ok: true },
      errorSnapshot: null, truncated: false,
      startedAt: "t", completedAt: "t",
    }],
    errorAtStep: null,
  };
}

// ---------------------------------------------------------------------------
// Scenario 8: capture mode sets X-Noukai-Session response header
// ---------------------------------------------------------------------------

describe("Express adapter — Phase 8", () => {
  it("8: capture mode sets X-Noukai-Session on the response", async () => {
    // Track which session id went on the outbound execute request.
    let outboundSessionId: string | undefined;

    fetchSpy.mockImplementation(async (_input, init) => {
      const headers = headersToRecord(init);
      outboundSessionId = headers[HEADER_SESSION_ID.toLowerCase()];
      return successExecuteResponse();
    });

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({});
    const res = makeMockRes();

    // Simulate a route handler that calls noukai.flow().execute() then signals done.
    await new Promise<void>((resolve, reject) => {
      middleware(req, res, (wrappedNext: unknown) => {
        const done = wrappedNext as (err?: unknown) => void;
        noukai.flow("a/b/c").execute({ message: "hi" })
          .then(() => {
            // Trigger writeHead to simulate Express committing the response.
            res.writeHead(200);
            done();
          })
          .then(resolve, reject);
      });
    });

    // The session header must be set.
    const responseSid = res.sentHeaders[HEADER_RESPONSE_SESSION.toLowerCase()];
    expect(responseSid).toBeTruthy();

    // The outbound execute request must carry the same session id.
    expect(outboundSessionId).toBe(responseSid);
  });

  it("8: multiple requests each get independent session ids", async () => {
    const sessionIds: string[] = [];

    fetchSpy.mockImplementation(async () => successExecuteResponse());

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    for (let i = 0; i < 3; i++) {
      const req = makeMockReq({});
      const res = makeMockRes();

      await new Promise<void>((resolve, reject) => {
        middleware(req, res, (wrappedNext: unknown) => {
          const done = wrappedNext as (err?: unknown) => void;
          noukai.flow("a/b/c").execute({ message: "hi" })
            .then(() => { res.writeHead(200); done(); })
            .then(resolve, reject);
        });
      });

      const sid = res.sentHeaders[HEADER_RESPONSE_SESSION.toLowerCase()];
      if (sid !== undefined) sessionIds.push(sid);
    }

    expect(sessionIds).toHaveLength(3);
    // All session ids must be distinct (each request gets its own capture session).
    expect(new Set(sessionIds).size).toBe(3);
  });

  it("8: replay header activates replay mode when NOUKAI_REPLAY_ENABLED=true", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse([sessionExecution({ result: { replayed: true } })]);
      }
      // Should not reach /execute in replay mode.
      return successExecuteResponse();
    });

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({
      [HEADER_REPLAY.toLowerCase()]: "11111111-1111-4111-8111-111111111111",
    });
    const res = makeMockRes();
    let replayResult: unknown;

    await new Promise<void>((resolve, reject) => {
      middleware(req, res, (wrappedNext: unknown) => {
        const done = wrappedNext as (err?: unknown) => void;
        noukai.flow("acme/spelling/grade-3").execute({ message: "hi" })
          .then((r) => {
            replayResult = r;
            res.writeHead(200);
            done();
          })
          .then(resolve, reject);
      });
    });

    // Replay mode: result came from snapshots, not the live network.
    expect((replayResult as { result: { replayed: boolean } }).result).toEqual({ replayed: true });
  });

  it("8: replay header ignored when NOUKAI_REPLAY_ENABLED is unset", async () => {
    delete process.env.NOUKAI_REPLAY_ENABLED;

    const executeCalls: string[] = [];
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      executeCalls.push(url);
      return successExecuteResponse();
    });

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({
      [HEADER_REPLAY.toLowerCase()]: "sess-ignored",
    });
    const res = makeMockRes();

    await new Promise<void>((resolve, reject) => {
      middleware(req, res, (wrappedNext: unknown) => {
        const done = wrappedNext as (err?: unknown) => void;
        noukai.flow("a/b/c").execute({ message: "hi" })
          .then(() => { res.writeHead(200); done(); })
          .then(resolve, reject);
      });
    });

    // Live /execute call was made (no session fetch).
    expect(executeCalls.some(u => u.endsWith("/execute"))).toBe(true);
    expect(executeCalls.some(u => u.includes("/seq/sessions/"))).toBe(false);
  });

  it("403 from session fetch → 403 JSON error response", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return new Response(
          JSON.stringify({ detail: { code: "FORBIDDEN", message: "no access" } }),
          { status: 403 },
        );
      }
      return successExecuteResponse();
    });

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({ [HEADER_REPLAY.toLowerCase()]: "11111111-1111-4111-8111-111111111111" });
    const res = makeMockRes();

    // The middleware will error before ever calling next — wait for it to settle.
    await new Promise<void>((resolve) => {
      middleware(req, res, (_wrappedNext: unknown) => {
        // If next is called at all, resolve so the promise settles.
        resolve();
      });
      // Poll for when error response is sent.
      const check = setInterval(() => {
        if (res.headersSent) { clearInterval(check); resolve(); }
      }, 5);
    });

    expect(res.statusCode).toBe(403);
    expect((res.responseBody as { error: string }).error).toBe("replay_forbidden");
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
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({ [HEADER_REPLAY.toLowerCase()]: "11111111-1111-4111-8111-111111111111" });
    const res = makeMockRes();

    await new Promise<void>((resolve) => {
      middleware(req, res, () => { resolve(); });
      const check = setInterval(() => {
        if (res.headersSent) { clearInterval(check); resolve(); }
      }, 5);
    });

    expect(res.statusCode).toBe(404);
    expect((res.responseBody as { error: string }).error).toBe("replay_session_not_found");
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
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({ [HEADER_REPLAY.toLowerCase()]: "11111111-1111-4111-8111-111111111111" });
    const res = makeMockRes();

    await new Promise<void>((resolve) => {
      middleware(req, res, () => { resolve(); });
      const check = setInterval(() => {
        if (res.headersSent) { clearInterval(check); resolve(); }
      }, 5);
    });

    expect(res.statusCode).toBe(410);
    expect((res.responseBody as { error: string }).error).toBe("replay_session_expired");
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
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({ [HEADER_REPLAY.toLowerCase()]: "11111111-1111-4111-8111-111111111111" });
    const res = makeMockRes();

    await new Promise<void>((resolve) => {
      middleware(req, res, () => { resolve(); });
      const check = setInterval(() => {
        if (res.headersSent) { clearInterval(check); resolve(); }
      }, 5);
    });

    expect(res.statusCode).toBe(400);
    expect((res.responseBody as { error: string }).error).toBe("replay_invalid_session");
  });

  it("no replay header → standard capture mode (no /sessions/ fetch)", async () => {
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (input) => {
      urls.push(fetchInputToString(input));
      return successExecuteResponse();
    });

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({});
    const res = makeMockRes();

    await new Promise<void>((resolve, reject) => {
      middleware(req, res, (wrappedNext: unknown) => {
        const done = wrappedNext as (err?: unknown) => void;
        noukai.flow("a/b/c").execute({ message: "hi" })
          .then(() => { res.writeHead(200); done(); })
          .then(resolve, reject);
      });
    });

    expect(urls.some(u => u.includes("/seq/sessions/"))).toBe(false);
    expect(urls.some(u => u.endsWith("/execute"))).toBe(true);
    // Capture session header is still set.
    expect(res.sentHeaders[HEADER_RESPONSE_SESSION.toLowerCase()]).toBeTruthy();
  });

  it("multiple X-Noukai-Replay values → first value wins", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/11111111-1111-4111-8111-aaaaaaaaaaaa")) {
        return sessionResponse([sessionExecution()]);
      }
      return new Response("{}", { status: 404 });
    });

    process.env.NOUKAI_REPLAY_ENABLED = "true";

    const noukai = new Noukai({ apiKey: "nk_test" });
    const middleware = noukaiTraceMiddleware({ client: noukai });

    const req = makeMockReq({
      [HEADER_REPLAY.toLowerCase()]: ["11111111-1111-4111-8111-aaaaaaaaaaaa", "22222222-2222-4222-8222-bbbbbbbbbbbb"],
    });
    const res = makeMockRes();

    await new Promise<void>((resolve, reject) => {
      middleware(req, res, (wrappedNext: unknown) => {
        const done = wrappedNext as (err?: unknown) => void;
        noukai.flow("acme/spelling/grade-3").execute({ message: "hi" })
          .then(() => { res.writeHead(200); done(); })
          .then(resolve, reject);
      });
    });

    // Test passes if no 404 is thrown — sess-first was used.
    expect(res.writeHeadCalled).toBe(true);
  });
});

