/**
 * Replay feature — 22 scenarios from design 20260605-SDK-replay-decorator.
 *
 * Capture mode (1–8) verifies session_id propagation through AsyncLocalStorage
 * and through the X-Session-Id outbound header.
 *
 * Replay mode (9–17) verifies slug-positional matching for execute(), exact
 * matching by (execution_id, step_index) for step() continuations, error
 * re-raising, and the leftover/miss detection.
 *
 * Production safety (18–20) verifies the NOUKAI_REPLAY_ENABLED env var gate
 * and the 403/410 error mapping.
 *
 * Edge (21–22) verifies undefined-behavior warning for concurrent same-slug
 * execute() and clean fall-through outside any scope.
 *
 * Phase 3 RED: all tests MUST FAIL with "Not implemented" (or assertion mismatch).
 * Phase 4+ will make them pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Noukai } from "../src/index.js";
import {
  ReplayForbiddenError,
  ReplayInvalidSessionError,
  ReplayLeftoverError,
  ReplayMissError,
  ReplayNoSnapshotsError,
  ReplaySessionExpiredError,
  ReplaySessionNotFoundError,
  FlowExecutionError,
} from "../src/errors.js";
import { replayScope, currentSessionId } from "../src/index.js";
import {
  HEADER_REPLAY,
  HEADER_SESSION_ID,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Global fetch spy — reset before each test.
// ---------------------------------------------------------------------------

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

// Restore env after each test that mutates it.
const originalEnv = { ...process.env };
afterEach(() => {
  // Restore only the REPLAY_ENABLED key we may have mutated.
  if (originalEnv.NOUKAI_REPLAY_ENABLED === undefined) {
    delete process.env.NOUKAI_REPLAY_ENABLED;
  } else {
    process.env.NOUKAI_REPLAY_ENABLED = originalEnv.NOUKAI_REPLAY_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Extract a URL string from a fetch `input` argument (string | URL | Request).
 * Typed as unknown to tolerate mock-call edge cases where vitest passes
 * an undefined value during spy reset transitions. */
function fetchInputToString(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input !== null && input !== undefined && typeof (input as Request).url === "string") {
    return (input as Request).url;
  }
  return String(input);
}

/** Extract headers from a fetch `init` into a plain lowercase-keyed object. */
function headersToRecord(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!init?.headers) return headers;
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  } else if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers as [string, string][]) {
      headers[k.toLowerCase()] = v;
    }
  } else {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return headers;
}

/**
 * Capture every fetch's URL + headers for assertions.
 * Mocks all calls to return a successful /execute response shape.
 */
function recordCalls(): { calls: { url: string; headers: Record<string, string>; body?: unknown }[] } {
  const calls: { url: string; headers: Record<string, string>; body?: unknown }[] = [];
  fetchSpy.mockImplementation(async (input, init) => {
    const url = fetchInputToString(input);
    const headers = headersToRecord(init);
    const body = init?.body !== undefined && init.body !== null
      ? JSON.parse(init.body as string) as unknown
      : undefined;
    calls.push({ url, headers, body });
    return new Response(JSON.stringify({
      status: "completed", result: { ok: true }, executionId: "exec-1",
      flowId: "f", blockCount: 1,
    }), { status: 200 });
  });
  return { calls };
}

function sessionResponse(executions: unknown[] = [], sessionId = "11111111-1111-4111-8111-111111111111"): Response {
  return new Response(JSON.stringify({ sessionId, executions }), { status: 200 });
}

function sessionExecution(opts: {
  executionId?: string;
  slug?: string;
  triggerType?: "execute" | "step" | "job";
  result?: unknown;
  snapshotsAvailable?: boolean;
  error?: { code: string; message: string };
  steps?: unknown[];
} = {}): unknown {
  return {
    executionId: opts.executionId ?? "exec-rec-1",
    flowId: "flow-1",
    // BARE flow.slug per BE wire shape — see BE design Q5 resolution.
    slug: opts.slug ?? "grade-3",
    triggerType: opts.triggerType ?? "execute",
    status: opts.error ? "failed" : "completed",
    startedAt: "2026-06-05T00:00:00Z",
    completedAt: "2026-06-05T00:00:01Z",
    traceCaptureMode: opts.snapshotsAvailable === false ? "off" : "full",
    snapshotsAvailable: opts.snapshotsAvailable !== false,
    steps: opts.steps ?? [{
      stepId: "s-1", blockId: "b-1", attempt: 1,
      inputSnapshot: { input: "x" }, outputSnapshot: opts.result ?? { ok: true },
      errorSnapshot: opts.error ?? null, truncated: false,
      startedAt: "t", completedAt: "t",
    }],
    errorAtStep: opts.error ? "s-1" : null,
  };
}

/**
 * Run fn with NOUKAI_REPLAY_ENABLED=true set for its duration.
 */
async function withReplayEnabled<T>(fn: () => Promise<T> | T): Promise<T> {
  const old = process.env.NOUKAI_REPLAY_ENABLED;
  process.env.NOUKAI_REPLAY_ENABLED = "true";
  try {
    return await Promise.resolve(fn());
  } finally {
    if (old === undefined) delete process.env.NOUKAI_REPLAY_ENABLED;
    else process.env.NOUKAI_REPLAY_ENABLED = old;
  }
}

// ---------------------------------------------------------------------------
// Capture mode (scenarios 1–8)
// ---------------------------------------------------------------------------

describe("Capture mode (scenarios 1–8)", () => {
  it("1: single execute call — header carries generated session_id", async () => {
    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });
    let scopeSid: string | null = null;

    await replayScope(async () => {
      scopeSid = currentSessionId();
      await noukai.flow("a/b/c").execute({ message: "hi" });
    });

    expect(scopeSid).toBeTruthy();
    expect(currentSessionId()).toBeNull();
    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()]).toBe(scopeSid);
  });

  it("2: multiple execute calls share session_id", async () => {
    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });

    await replayScope(async () => {
      await noukai.flow("a/b/c").execute({ message: "1" });
      await noukai.flow("a/b/c").execute({ message: "2" });
      await noukai.flow("a/b/d").execute({ message: "3" });
    });

    const sids = calls.map(c => c.headers[HEADER_SESSION_ID.toLowerCase()]);
    expect(new Set(sids).size).toBe(1);
    expect(sids[0]).toBeTruthy();
  });

  it("3: nested async function propagates AsyncLocalStorage", async () => {
    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });
    let sid: string | null = null;

    const deeper = async () => {
      await noukai.flow("a/b/c").execute({ message: "hi" });
    };

    await replayScope(async () => {
      sid = currentSessionId();
      await deeper();
    });

    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()]).toBe(sid);
  });

  it("4: step-through events flow shares session_id", async () => {
    // Capture headers from the SSE request.
    const captured: { url: string; headers: Record<string, string> }[] = [];

    fetchSpy.mockImplementation(async (input, init) => {
      captured.push({ url: fetchInputToString(input), headers: headersToRecord(init) });
      return new Response(
        'data: {"eventType":"run_started","runId":"r","executionId":"e"}\n\n' +
        'data: {"eventType":"step_completed","stepId":"s-1","output":{"ok":true}}\n\n' +
        'data: {"eventType":"flow_completed","executionId":"e","result":{"ok":true}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const noukai = new Noukai({ apiKey: "nk_x" });
    let scopeSid: string | null = null;

    await replayScope(async () => {
      scopeSid = currentSessionId();
      for await (const _evt of noukai.flow("a/b/c").events({ message: "hi" })) {
        // consume all events
      }
    });

    const sids = new Set(captured.map(c => c.headers[HEADER_SESSION_ID.toLowerCase()]));
    expect(sids).toEqual(new Set([scopeSid]));
  });

  it("5: mixed execute + step in same scope share session_id", async () => {
    const captured: string[] = [];

    fetchSpy.mockImplementation(async (input, init) => {
      const headers = headersToRecord(init);
      captured.push(headers[HEADER_SESSION_ID.toLowerCase()] ?? "");

      const url = fetchInputToString(input);
      if (url.endsWith("/execute")) {
        return new Response(JSON.stringify({
          status: "completed", result: { ok: true }, executionId: "e", flowId: "f", blockCount: 1,
        }), { status: 200 });
      }
      return new Response(
        'data: {"eventType":"flow_completed","result":{"ok":true}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const noukai = new Noukai({ apiKey: "nk_x" });
    let scopeSid: string | null = null;

    await replayScope(async () => {
      scopeSid = currentSessionId();
      await noukai.flow("a/b/c").execute({ message: "hi" });
      for await (const _evt of noukai.flow("a/b/c").events({ message: "hi2" })) {
        // consume
      }
    });

    expect(new Set(captured)).toEqual(new Set([scopeSid]));
  });

  it("6: no scope — no header sent", async () => {
    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });

    await noukai.flow("a/b/c").execute({ message: "hi" });

    // Outside any scope — X-Session-Id must be absent or empty.
    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()] ?? "").toBe("");
  });

  it("7: explicit sessionId option overrides AsyncLocalStorage", async () => {
    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });
    let scopeSid: string | null = null;

    await replayScope(async () => {
      scopeSid = currentSessionId();
      await noukai.flow("a/b/c").execute({ message: "hi", sessionId: "explicit-sid" });
    });

    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()]).toBe("explicit-sid");
    expect(scopeSid).not.toBe("explicit-sid");
  });

  it.skip(
    "8: response header — see adapter tests in tests/adapters/express.test.ts",
    // Scenario 8 is exercised in Phase 8 framework-adapter tests, NOT here —
    // the SDK core does not own the response header. This test documents the
    // cross-reference. See tests/adapters/express.test.ts (Phase 8).
  );

  // -------------------------------------------------------------------------
  // Phase 5: capture-mode UX polish
  // -------------------------------------------------------------------------

  it("P5-1: log handler receives scope_open and scope_close events", async () => {
    const logEvents: any[] = [];
    const { calls } = recordCalls();
    void calls; // consumed by recordCalls side-effect; referenced below via fetchSpy

    const noukai = new Noukai({ apiKey: "nk_x", onLog: (e) => logEvents.push(e) });

    let scopeSid: string | null = null;
    await replayScope(async () => {
      scopeSid = currentSessionId();
      await noukai.flow("a/b/c").execute({ message: "hi" });
    }, { transport: noukai._transport });

    const phases = logEvents.map((e: { phase?: string }) => e.phase);
    expect(phases).toContain("scope_open");
    expect(phases).toContain("scope_close");

    // scope_open carries the generated session id
    const openEvt = logEvents.find((e: any) => e.phase === "scope_open");
    expect(openEvt).toBeDefined();
    expect(openEvt?.sessionId).toBe(scopeSid);
    expect(openEvt?.sessionId).toBeTruthy();
  });

  it("P5-2: scope_close fires even when the body throws", async () => {
    // Use recordCalls() to set a live fetch mock — required because the
    // Vitest 3.2.6 runner calls fetch(undefined) during cleanup hooks when
    // no mock implementation is active after mockReset().
    recordCalls();
    const logEvents: any[] = [];
    const noukai = new Noukai({ apiKey: "nk_x", onLog: (e) => logEvents.push(e) });

    await expect(
      replayScope(async () => {
        throw new Error("deliberate body error");
      }, { transport: noukai._transport }),
    ).rejects.toThrow("deliberate body error");

    const phases = logEvents.map((e: { phase?: string }) => e.phase);
    expect(phases).toContain("scope_open");
    expect(phases).toContain("scope_close");
  });

  it("P5-3: no log events emitted when no onLog hook is configured", async () => {
    // Confirm _emitLog is a no-op when onLog is absent.
    const { calls } = recordCalls();

    const noukai = new Noukai({ apiKey: "nk_x" }); // no onLog
    let scopeSid: string | null = null;

    // Should not throw even though _emitLog is called internally.
    await replayScope(async () => {
      scopeSid = currentSessionId();
      await noukai.flow("a/b/c").execute({ message: "hi" });
    }, { transport: noukai._transport });

    expect(scopeSid).toBeTruthy();
    // The execute call still went out; no side-effects from missing log handler.
    expect(calls.length).toBe(1);
  });

  it("P5-4: ExecuteResult carries sessionId inside a trace scope", async () => {
    const { calls } = recordCalls();
    void calls;

    const noukai = new Noukai({ apiKey: "nk_x" });
    let scopeSid: string | null = null;
    let resultSid: string | undefined;

    await replayScope(async () => {
      scopeSid = currentSessionId();
      const result = await noukai.flow("a/b/c").execute({ message: "hi" });
      resultSid = result.sessionId;
    });

    expect(scopeSid).toBeTruthy();
    expect(resultSid).toBe(scopeSid);
  });

  it("P5-5: ExecuteResult.sessionId is undefined outside a trace scope", async () => {
    recordCalls();

    const noukai = new Noukai({ apiKey: "nk_x" });
    const result = await noukai.flow("a/b/c").execute({ message: "hi" });

    expect(result.sessionId).toBeUndefined();
  });

  it("P5-6: ExecuteResult.sessionId uses explicit sessionId option when provided", async () => {
    const { calls } = recordCalls();
    void calls;

    const noukai = new Noukai({ apiKey: "nk_x" });
    let resultSid: string | undefined;

    await replayScope(async () => {
      const result = await noukai.flow("a/b/c").execute({
        message: "hi",
        sessionId: "explicit-override",
      });
      resultSid = result.sessionId;
    });

    // Explicit option has highest precedence.
    expect(resultSid).toBe("explicit-override");
  });

  it("P5-7: scope_open event mode matches CAPTURE when no replaySessionId", async () => {
    // Use recordCalls() to set a live fetch mock — required because the
    // Vitest 3.2.6 runner calls fetch(undefined) during cleanup hooks when
    // no mock implementation is active after mockReset().
    recordCalls();
    const logEvents: any[] = [];
    const noukai = new Noukai({ apiKey: "nk_x", onLog: (e) => logEvents.push(e) });

    await replayScope(async () => {
      // just enter and exit
    }, { transport: noukai._transport });

    const openEvt = logEvents.find((e: any) => e.phase === "scope_open");
    expect(openEvt?.mode).toBe("capture");
  });

  it("P5-8: sessionId is UUID v4 format (random, not time-ordered)", async () => {
    // R9: confirm UUID v4 — 8-4-4-4-12 hex with version nibble 4.
    // crypto.randomUUID() in Node is always v4 per WHATWG spec.
    const { calls } = recordCalls();
    void calls;

    const noukai = new Noukai({ apiKey: "nk_x" });
    let sid: string | null = null;

    await replayScope(async () => {
      sid = currentSessionId();
    });

    expect(sid).toBeTruthy();
    // UUID v4: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    const uuid4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(sid).toMatch(uuid4Re);
  });
});

// ---------------------------------------------------------------------------
// Replay mode (scenarios 9–17)
// ---------------------------------------------------------------------------

describe("Replay mode (scenarios 9–17)", () => {
  it("9: single execute serves recorded output, no /execute call", async () => {
    const urlsSeen: string[] = [];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      // Only record non-cleanup calls (Vitest 3.2.6 calls fetch(undefined) on cleanup).
      if (url !== "undefined") urlsSeen.push(url);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse([sessionExecution({ result: { answer: 42 } })]);
      }
      // Absorb Vitest cleanup fetch(undefined) call — see P5-2 comment.
      return new Response("{}", { status: 200 });
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        const result = await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        // In replay mode result.result should be the recorded output.
        expect((result as { result: { answer: number } }).result).toEqual({ answer: 42 });
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });

    // Only the prefetch GET was made; no /execute call.
    expect(urlsSeen.every(u => u.includes("/seq/sessions/"))).toBe(true);
  });

  it("10: slug-positional matching for same slug", async () => {
    const execs = [
      sessionExecution({ executionId: "r-1", result: { n: 1 } }),
      sessionExecution({ executionId: "r-2", result: { n: 2 } }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        const r1 = await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        const r2 = await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        expect((r1 as { result: { n: number } }).result).toEqual({ n: 1 });
        expect((r2 as { result: { n: number } }).result).toEqual({ n: 2 });
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });
  });

  it("11: independent counters per slug", async () => {
    const execs = [
      sessionExecution({ executionId: "A1", slug: "A", result: { x: "A1" } }),
      sessionExecution({ executionId: "B1", slug: "B", result: { x: "B1" } }),
      sessionExecution({ executionId: "A2", slug: "A", result: { x: "A2" } }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        const a1 = await noukai.flow("org/proj/A").execute({ message: "hi" });
        const b1 = await noukai.flow("org/proj/B").execute({ message: "hi" });
        const a2 = await noukai.flow("org/proj/A").execute({ message: "hi" });
        expect((a1 as { result: { x: string } }).result).toEqual({ x: "A1" });
        expect((b1 as { result: { x: string } }).result).toEqual({ x: "B1" });
        expect((a2 as { result: { x: string } }).result).toEqual({ x: "A2" });
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });
  });

  it("12: step flow substitutes recorded execution_id", async () => {
    const execs = [
      sessionExecution({
        executionId: "rec-step-exec",
        triggerType: "step",
        slug: "grade-3",
        steps: [
          {
            stepId: "s-1", blockId: "b-1", attempt: 1,
            inputSnapshot: {}, outputSnapshot: { step: 1 },
            errorSnapshot: null, truncated: false, startedAt: "t", completedAt: "t",
          },
          {
            stepId: "s-2", blockId: "b-2", attempt: 1,
            inputSnapshot: {}, outputSnapshot: { step: 2 },
            errorSnapshot: null, truncated: false, startedAt: "t", completedAt: "t",
          },
        ],
      }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        const stepOutputs: unknown[] = [];
        for await (const evt of noukai.flow("org/proj/grade-3").events({ message: "hi" })) {
          if (evt.type === "step_completed") {
            stepOutputs.push((evt as { type: string; output: unknown }).output);
          }
        }
        // SDK should reconstruct step_completed events from snapshots.
        expect(stepOutputs).toEqual([{ step: 1 }, { step: 2 }]);
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });
  });

  it("13: parallel step flows to same slug", async () => {
    const execs = [
      sessionExecution({
        executionId: "rec-A1", triggerType: "step", slug: "A",
        steps: [{
          stepId: "s-1", blockId: "b", attempt: 1,
          inputSnapshot: {}, outputSnapshot: { flow: "A1" },
          errorSnapshot: null, truncated: false, startedAt: "t", completedAt: "t",
        }],
      }),
      sessionExecution({
        executionId: "rec-A2", triggerType: "step", slug: "A",
        steps: [{
          stepId: "s-1", blockId: "b", attempt: 1,
          inputSnapshot: {}, outputSnapshot: { flow: "A2" },
          errorSnapshot: null, truncated: false, startedAt: "t", completedAt: "t",
        }],
      }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    const consume = async (msg: string): Promise<unknown[]> => {
      const outputs: unknown[] = [];
      for await (const evt of noukai.flow("org/proj/A").events({ message: msg })) {
        if (evt.type === "step_completed") {
          outputs.push((evt as { type: string; output: unknown }).output);
        }
      }
      return outputs;
    };

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        const [r1, r2] = await Promise.all([consume("1"), consume("2")]);
        const flowValues = new Set([
          (r1[0] as { flow: string } | undefined)?.flow,
          (r2[0] as { flow: string } | undefined)?.flow,
        ]);
        expect(flowValues).toEqual(new Set(["A1", "A2"]));
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });
  });

  it("14: recorded error is re-raised", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse([sessionExecution({
          error: { code: "FLOW_EXECUTION_ERROR", message: "boom" },
        })]);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toThrow(/boom/);
    });
  });

  it("15: extra code call raises ReplayMissError", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse([sessionExecution({ result: { only: "one" } })]);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
          // Second call has no recorded execution → ReplayMissError.
          await noukai.flow("acme/spelling/grade-3").execute({ message: "hi2" });
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplayMissError);
    });
  });

  it("16: unconsumed executions raise ReplayLeftoverError at scope exit", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse([
          sessionExecution({ executionId: "a", result: { i: 0 } }),
          sessionExecution({ executionId: "b", result: { i: 1 } }),
        ]);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          // Only consume 1 of 2 recorded executions — leftover on exit.
          await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplayLeftoverError);
    });
  });

  it("17: explicit sessionId option in replay uses override session (one-shot fetch)", async () => {
    const execs = [
      sessionExecution({ executionId: "from-contextvar", result: { x: 0 } }),
      sessionExecution({ executionId: "from-explicit", result: { x: 1 } }),
    ];
    const explicitExecs = [
      sessionExecution({ executionId: "from-explicit", result: { x: 99 } }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/11111111-1111-4111-8111-111111111111")) {
        return sessionResponse(execs, "11111111-1111-4111-8111-111111111111");
      }
      if (url.includes("/seq/sessions/22222222-2222-4222-8222-222222222222")) {
        return sessionResponse(explicitExecs, "22222222-2222-4222-8222-222222222222");
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        const first = await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
        const explicit = await noukai.flow("acme/spelling/grade-3").execute({
          message: "hi",
          sessionId: "22222222-2222-4222-8222-222222222222",
        });
        expect((first as { result: { x: number } }).result).toEqual({ x: 0 });
        // The explicit kwarg used the override session (sess-2).
        expect((explicit as { result: { x: number } }).result).toEqual({ x: 99 });
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });
  });
});

// ---------------------------------------------------------------------------
// Production safety (scenarios 18–20)
// ---------------------------------------------------------------------------

describe("Production safety (scenarios 18–20)", () => {
  it("18: replay header ignored when env var unset — scope becomes capture", async () => {
    // Ensure NOUKAI_REPLAY_ENABLED is unset.
    delete process.env.NOUKAI_REPLAY_ENABLED;

    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });
    let scopeSid: string | null = null;

    await replayScope(async () => {
      scopeSid = currentSessionId();
      await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });
    }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });

    // The /execute call was made (CAPTURE mode, not replay intercept).
    expect(calls.some(c => c.url.endsWith("/execute"))).toBe(true);
    // The header carries the freshly-generated capture session_id, NOT "11111111-1111-4111-8111-111111111111".
    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()]).toBe(scopeSid);
    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()]).not.toBe("11111111-1111-4111-8111-111111111111");
  });

  it("19: 403 maps to ReplayForbiddenError", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return new Response(
          JSON.stringify({ detail: { code: "FORBIDDEN", message: "no" } }),
          { status: 403 },
        );
      }
      // Absorb the Vitest 3.2.6 cleanup fetch(undefined) call that fires after
      // mockReset() during test teardown. See P5-2 comment for explanation.
      return new Response("{}", { status: 200 });
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          // Scope prefetch throws before body runs.
          await Promise.resolve();
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplayForbiddenError);
    });
  });

  it("20: 410 maps to ReplaySessionExpiredError (deferred — BE 410 not in v1)", async () => {
    // BE does not define 410 in v1 (TTL deferred to existing trace retention
    // policy). Test is marked to skip until TTL ships.
    // See phase-3-red-tests.md § Scenarios 18–20 for rationale.
    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return new Response(
          JSON.stringify({ detail: { code: "GONE", message: "expired" } }),
          { status: 410 },
        );
      }
      // Absorb the Vitest 3.2.6 cleanup fetch(undefined) call that fires after
      // mockReset() during test teardown. See P5-2 comment for explanation.
      return new Response("{}", { status: 200 });
    });

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          // Scope prefetch throws before body runs.
          await Promise.resolve();
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplaySessionExpiredError);
    });
  });
});

// ---------------------------------------------------------------------------
// Production safety — extra error mappings (beyond the 22 core scenarios)
// ---------------------------------------------------------------------------

describe("Production safety — extra error mappings", () => {
  it("(extra) 404 maps to ReplaySessionNotFoundError", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ detail: { code: "NOT_FOUND", message: "no" } }),
        { status: 404 },
      ),
    );

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          await Promise.resolve();
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplaySessionNotFoundError);
    });
  });

  it("(extra) 400 maps to ReplayInvalidSessionError", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ detail: { code: "BAD_REQUEST", message: "no" } }),
        { status: 400 },
      ),
    );

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          await Promise.resolve();
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplayInvalidSessionError);
    });
  });

  it("(extra) snapshotsAvailable=false raises ReplayNoSnapshotsError", async () => {
    fetchSpy.mockImplementation(async () =>
      sessionResponse([sessionExecution({ snapshotsAvailable: false })]),
    );

    const noukai = new Noukai({ apiKey: "nk_x" });

    await withReplayEnabled(async () => {
      await expect(
        replayScope(async () => {
          await Promise.resolve();
        }, { replaySessionId: "11111111-1111-4111-8111-111111111111" }),
      ).rejects.toBeInstanceOf(ReplayNoSnapshotsError);
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases (scenarios 21–22)
// ---------------------------------------------------------------------------

describe("Edge cases (scenarios 21–22)", () => {
  it("21: concurrent same-slug emits warning (undefined behavior — detection only)", async () => {
    const execs = [
      sessionExecution({ executionId: "A1", slug: "A", result: { x: "A1" } }),
      sessionExecution({ executionId: "A2", slug: "A", result: { x: "A2" } }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 }); // absorb Vitest cleanup fetch(undefined)
    });

    const noukai = new Noukai({ apiKey: "nk_x" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        // Two parallel execute() calls with the same slug — undefined behavior.
        await Promise.all([
          noukai.flow("a/b/A").execute({ message: "1" }),
          noukai.flow("a/b/A").execute({ message: "2" }),
        ]);
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });

    // Detection requirement: at least one warning mentioning "concurrent".
    const concurrentWarnings = warnSpy.mock.calls.filter(args =>
      args.some(a => typeof a === "string" && a.toLowerCase().includes("concurrent")),
    );
    expect(concurrentWarnings.length).toBeGreaterThanOrEqual(1);

    warnSpy.mockRestore();
  });

  it("22: execute outside scope behaves normally — no header, real call", async () => {
    const { calls } = recordCalls();
    const noukai = new Noukai({ apiKey: "nk_x" });

    // No replayScope wrapping.
    const result = await noukai.flow("acme/spelling/grade-3").execute({ message: "hi" });

    expect((result as { result: { ok: boolean } }).result).toEqual({ ok: true });
    // X-Session-Id must be absent or empty.
    expect(calls[0]?.headers[HEADER_SESSION_ID.toLowerCase()] ?? "").toBe("");
    // X-Noukai-Replay header must not be sent by the SDK.
    expect(calls[0]?.headers[HEADER_REPLAY.toLowerCase()] ?? "").toBe("");
  });
});

// ---------------------------------------------------------------------------
// SSE reconstruction (Phase 7) — canonical event order validation
// ---------------------------------------------------------------------------

describe("SSE reconstruction", () => {
  it("reconstructed event order: run_started → per-step → flow_completed", async () => {
    const execs = [
      sessionExecution({
        executionId: "r",
        triggerType: "step",
        slug: "A",
        steps: [
          {
            stepId: "s-1", blockId: "b", attempt: 1,
            inputSnapshot: {}, outputSnapshot: { v: 1 },
            errorSnapshot: null, truncated: false,
            startedAt: "t", completedAt: "t",
          },
          {
            stepId: "s-2", blockId: "b", attempt: 1,
            inputSnapshot: {}, outputSnapshot: { v: 2 },
            errorSnapshot: null, truncated: false,
            startedAt: "t", completedAt: "t",
          },
        ],
      }),
    ];

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 });
    });

    const noukai = new Noukai({ apiKey: "nk_x" });
    const typesSeen: string[] = [];

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        for await (const evt of noukai.flow("org/proj/A").events({ message: "hi" })) {
          typesSeen.push(evt.type);
        }
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });

    expect(typesSeen).toEqual([
      "run_started",
      "step_started", "step_completed",
      "step_started", "step_completed",
      "flow_completed",
    ]);
  });

  it("reconstructed event order with step error: stops after step_error + flow_completed", async () => {
    const execs = [
      sessionExecution({
        executionId: "r",
        triggerType: "step",
        slug: "A",
        steps: [
          {
            stepId: "s-1", blockId: "b", attempt: 1,
            inputSnapshot: {}, outputSnapshot: { v: 1 },
            errorSnapshot: null, truncated: false,
            startedAt: "t", completedAt: "t",
          },
          {
            stepId: "s-2", blockId: "b", attempt: 1,
            inputSnapshot: {}, outputSnapshot: null,
            errorSnapshot: { code: "E", message: "boom" },
            truncated: false, startedAt: "t", completedAt: "t",
          },
        ],
      }),
    ];
    // Mark execution as failed with errorAtStep.
    (execs[0] as Record<string, unknown>).errorAtStep = "s-2";
    (execs[0] as Record<string, unknown>).status = "failed";

    fetchSpy.mockImplementation(async (input) => {
      const url = fetchInputToString(input);
      if (url.includes("/seq/sessions/")) {
        return sessionResponse(execs);
      }
      return new Response("{}", { status: 200 });
    });

    const noukai = new Noukai({ apiKey: "nk_x" });
    const typesSeen: string[] = [];

    await withReplayEnabled(async () => {
      await replayScope(async () => {
        for await (const evt of noukai.flow("org/proj/A").events({ message: "hi" })) {
          typesSeen.push(evt.type);
        }
      }, { replaySessionId: "11111111-1111-4111-8111-111111111111" });
    });

    // Reconstructor emits: run_started, s-1 started+completed, s-2 started+error,
    // then a terminal flow_completed (with failedAtStep summary) and stops.
    expect(typesSeen).toEqual([
      "run_started",
      "step_started", "step_completed",  // s-1 succeeded
      "step_started", "step_error",       // s-2 failed
      "flow_completed",
    ]);
  });
});

// Suppress unused-import lint noise — errors imported for isinstance checks are
// reference-only. These void statements keep tree-shake from dropping the imports.
void FlowExecutionError;
void ReplayLeftoverError;
void ReplayMissError;
void ReplayNoSnapshotsError;
void ReplaySessionExpiredError;
void ReplaySessionNotFoundError;
void ReplayInvalidSessionError;
void ReplayForbiddenError;
