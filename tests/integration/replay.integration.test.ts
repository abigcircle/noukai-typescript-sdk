/**
 * Integration tests for the replay feature against a live Noukai server.
 *
 * Covers the trace-scope feature end-to-end:
 *
 * - **Capture mode** (live today): scope opens, `X-Session-Id` flows on the
 *   wire, `result.sessionId` surfaces on the user-facing object, the existing
 *   execute() contract is untouched.
 * - **Replay mode** (gated): requires the BE session-grouping endpoint
 *   (see design 20260605-BE-execution-session-grouping). When that ships, set
 *   `NOUKAI_INTEGRATION_REPLAY_READY=1` to enable the replay round-trip tests.
 * - **Express adapter** (live today): real HTTP server, real backend, asserts
 *   the `X-Noukai-Session` response header is set on the user-facing response.
 *
 * The adapter test uses Node's built-in `http` module rather than Express so
 * the SDK's `express` peer dependency doesn't have to be installed locally.
 * `noukaiTraceMiddleware` is typed structurally — it works against any
 * `(req, res, next)` triple that satisfies the minimal interfaces.
 *
 * Skipped by default — set the NOUKAI_INTEGRATION_* env vars to enable.
 * See `tests/integration/README.md` for setup instructions.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  currentSessionId,
  type ExecuteResult,
  type FlowCompleted,
  type Noukai,
  ReplayError,
  ReplayLeftoverError,
  ReplayMissError,
  type StepCompleted,
  type StreamEvent,
  replayScope,
} from "../../src/index.js";
import { noukaiTraceMiddleware } from "../../src/adapters/express.js";
import {
  helloFlow,
  HELLO_SLUG,
  integrationReady,
  makeClient,
  twoStepFlow,
  twoStepReady,
} from "./helpers.js";

// --------------------------------------------------------------------------- //
// Gates                                                                       //
// --------------------------------------------------------------------------- //

const REPLAY_READY: boolean =
  integrationReady &&
  ["1", "true", "True"].includes(process.env.NOUKAI_INTEGRATION_REPLAY_READY ?? "");

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HEADER_NOUKAI_SESSION = "x-noukai-session";

// --------------------------------------------------------------------------- //
// Capture mode — live against the real backend                                //
// --------------------------------------------------------------------------- //

describe.skipIf(!integrationReady)("replay capture (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "trace scope surfaces sessionId on ExecuteResult",
    async () => {
      let observedSessionId: string | null = null;
      const result = await replayScope<ExecuteResult>(
        async () => {
          observedSessionId = currentSessionId();
          const r = await helloFlow(client).execute({ message: "capture-mode integration" });
          if (r.requiresToolCalls) throw new Error("unexpected pause");
          return r;
        },
        { transport: client._transport },
      );

      expect(result.status).toBe("completed");
      expect(observedSessionId).toBeTruthy();
      expect(observedSessionId).toMatch(UUID_V4_RE);
      expect(result.sessionId).toBe(observedSessionId);
    },
    60_000,
  );

  it(
    "multiple execute() calls in the same scope share the sessionId",
    async () => {
      const collected: { sessionId: string | undefined; executionId: string | undefined }[] =
        [];

      const sessionId = await replayScope<string>(
        async () => {
          for (const msg of ["first", "second"]) {
            const r = await helloFlow(client).execute({ message: msg });
            if (r.requiresToolCalls) throw new Error("unexpected pause");
            collected.push({ sessionId: r.sessionId, executionId: r.executionId });
          }
          const sid = currentSessionId();
          if (sid === null) throw new Error("session id was null inside scope");
          return sid;
        },
        { transport: client._transport },
      );

      expect(collected).toHaveLength(2);
      expect(collected[0]?.sessionId).toBe(sessionId);
      expect(collected[1]?.sessionId).toBe(sessionId);
      expect(collected[0]?.executionId).not.toBe(collected[1]?.executionId);
    },
    120_000,
  );

  it("currentSessionId() returns null outside any scope", () => {
    expect(currentSessionId()).toBeNull();
  });

  it(
    "unwrapped execute() preserves backwards-compat — no sessionId on result",
    async () => {
      const r = await helloFlow(client).execute({ message: "no scope" });
      if (r.requiresToolCalls) throw new Error("unexpected pause");
      expect(r.status).toBe("completed");
      expect(r.sessionId).toBeUndefined();
    },
    60_000,
  );
});

// --------------------------------------------------------------------------- //
// Express adapter — real HTTP route, real backend                             //
// --------------------------------------------------------------------------- //

describe.skipIf(!integrationReady)("replay express adapter (integration)", () => {
  let client: Noukai;
  let server: Server;
  let baseUrl: string;

  /**
   * Read the full body of an IncomingMessage, then JSON.parse it.
   * Returns {} when the request had no body.
   */
  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text === "") {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      req.on("error", (err) => {
        reject(err);
      });
    });
  }

  beforeAll(async () => {
    client = makeClient();
    const middleware = noukaiTraceMiddleware({ client });

    server = createServer((req, res) => {
      // The middleware's structural interface (MinimalReq has `headers`,
      // ExtendedRes has setHeader/writeHead/headersSent) is a subset of
      // Node's IncomingMessage / ServerResponse. The express-only methods
      // `.status(code).json(body)` are used by the middleware only on its
      // own error-mapping path (replay session fetch failure). Our success
      // path doesn't trigger them, so we can substitute stubs.
      const resAdapter = res as unknown as ServerResponse & {
        status: (code: number) => ServerResponse & { json: (body: unknown) => void };
        json: (body: unknown) => void;
      };
      resAdapter.status = (code: number) => {
        res.statusCode = code;
        return resAdapter;
      };
      resAdapter.json = (body: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };

      // The middleware's `next` argument is invoked with a `wrappedNext`
      // callback (not a standard Express `next`). The middleware needs us to
      // invoke that callback when the downstream chain finishes, so it can
      // resolve the Promise wrapping the replayScope body. See express.ts.
      middleware(
        req as unknown as Parameters<typeof middleware>[0],
        resAdapter,
        (downstreamCb: unknown) => {
          const continueDownstream = downstreamCb as (err?: unknown) => void;

          void (async () => {
            try {
              if (req.method === "POST" && req.url === "/run") {
                await readJsonBody(req);
                const r = await client.flow(HELLO_SLUG ?? "").execute({
                  message: "adapter integration",
                });
                if (r.requiresToolCalls) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: "unexpected pause" }));
                  return;
                }
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ status: r.status, sessionId: r.sessionId ?? null }));
              } else {
                res.statusCode = 404;
                res.end();
              }
              continueDownstream();
            } catch (handlerErr) {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.end(
                  JSON.stringify({
                    error: handlerErr instanceof Error ? handlerErr.message : "unknown error",
                  }),
                );
              }
              continueDownstream(handlerErr);
            }
          })();
        },
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${String(addr.port)}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      });
    });
    await client.close();
  });

  it(
    "sets X-Noukai-Session on the response and matches result.sessionId",
    async () => {
      const resp = await fetch(`${baseUrl}/run`, { method: "POST" });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string; sessionId: string | null };
      expect(body.status).toBe("completed");
      expect(body.sessionId).toBeTruthy();
      expect(resp.headers.get(HEADER_NOUKAI_SESSION)).toBe(body.sessionId);
    },
    60_000,
  );
});

// --------------------------------------------------------------------------- //
// Replay mode — gated on the BE session-grouping endpoint                     //
// --------------------------------------------------------------------------- //

describe.skipIf(!REPLAY_READY)("replay round-trip (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
    process.env.NOUKAI_REPLAY_ENABLED = "true";
  });

  afterEach(async () => {
    delete process.env.NOUKAI_REPLAY_ENABLED;
    await client.close();
  });

  it(
    "captured session replays the same output without re-invoking the model",
    async () => {
      const captured = await replayScope<{
        sessionId: string;
        executionId: string | undefined;
        result: unknown;
      }>(
        async () => {
          const r = await helloFlow(client).execute({ message: "replay round-trip seed" });
          if (r.requiresToolCalls) throw new Error("unexpected pause");
          if (!r.sessionId) throw new Error("capture: sessionId missing on result");
          return { sessionId: r.sessionId, executionId: r.executionId, result: r.result };
        },
        { transport: client._transport },
      );

      const replayed = await replayScope<ExecuteResult>(
        async () => {
          const r = await helloFlow(client).execute({ message: "replay round-trip seed" });
          if (r.requiresToolCalls) throw new Error("unexpected pause");
          return r;
        },
        { replaySessionId: captured.sessionId, transport: client._transport },
      );

      expect(replayed.status).toBe("completed");
      expect(replayed.executionId).toBe(captured.executionId);
      expect(replayed.result).toEqual(captured.result);
    },
    120_000,
  );

  it(
    "extra execute() call beyond what was recorded raises ReplayError",
    async () => {
      const captured = await replayScope<string>(
        async () => {
          await helloFlow(client).execute({ message: "first and only recorded call" });
          const sid = currentSessionId();
          if (sid === null) throw new Error("session id was null inside scope");
          return sid;
        },
        { transport: client._transport },
      );

      await expect(
        replayScope(
          async () => {
            await helloFlow(client).execute({ message: "first replayed call" });
            await helloFlow(client).execute({ message: "second call — no recording" });
          },
          { replaySessionId: captured, transport: client._transport },
        ),
      ).rejects.toBeInstanceOf(ReplayError);
    },
    120_000,
  );
});

// --------------------------------------------------------------------------- //
// Complex replay — multi-flow, mixed-API scopes                                //
// --------------------------------------------------------------------------- //
//
// Production replay isn't a single execute(): a real route handler typically
// mixes execute() against a worker flow, events() for SSE forwarding to the
// frontend, and possibly multiple flow slugs in the same request. These tests
// exercise that surface against a live backend.
//
// All gated on REPLAY_READY && twoStepReady — the two-step fixture flow lets us
// verify multi-block SSE reconstruction (Phase 7) which the hello fixture can't.

async function collectStream(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe.skipIf(!REPLAY_READY || !twoStepReady)("replay complex scenarios (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
    process.env.NOUKAI_REPLAY_ENABLED = "true";
  });

  afterEach(async () => {
    delete process.env.NOUKAI_REPLAY_ENABLED;
    await client.close();
  });

  it(
    "mixed execute() + events() across two flows replays end-to-end",
    async () => {
      // --- Capture phase ---
      const captured = await replayScope<{
        sessionId: string;
        hello1: ExecuteResult;
        twoStepEvents: StreamEvent[];
        hello2: ExecuteResult;
      }>(
        async () => {
          const r1 = await helloFlow(client).execute({ message: "setup call" });
          if (r1.requiresToolCalls) throw new Error("unexpected pause on hello 1");
          const events = await collectStream(
            twoStepFlow(client).events({ message: "streaming inner flow" }),
          );
          const r2 = await helloFlow(client).execute({ message: "post-processing call" });
          if (r2.requiresToolCalls) throw new Error("unexpected pause on hello 2");
          const sid = currentSessionId();
          if (sid === null) throw new Error("session id null inside scope");
          return { sessionId: sid, hello1: r1, twoStepEvents: events, hello2: r2 };
        },
        { transport: client._transport },
      );

      // Sanity: the two-step fixture emitted 2 step_completed events.
      const capturedStepCount = captured.twoStepEvents.filter(
        (e) => e.type === "step_completed",
      ).length;
      expect(capturedStepCount).toBe(2);

      // --- Replay phase ---
      const replayed = await replayScope<{
        hello1: ExecuteResult;
        twoStepEvents: StreamEvent[];
        hello2: ExecuteResult;
      }>(
        async () => {
          const r1 = await helloFlow(client).execute({ message: "setup call" });
          if (r1.requiresToolCalls) throw new Error("unexpected pause on hello 1");
          const events = await collectStream(
            twoStepFlow(client).events({ message: "streaming inner flow" }),
          );
          const r2 = await helloFlow(client).execute({ message: "post-processing call" });
          if (r2.requiresToolCalls) throw new Error("unexpected pause on hello 2");
          return { hello1: r1, twoStepEvents: events, hello2: r2 };
        },
        { replaySessionId: captured.sessionId, transport: client._transport },
      );

      // execute() identity: same execution_id means the model was not re-invoked.
      expect(replayed.hello1.executionId).toBe(captured.hello1.executionId);
      expect(replayed.hello2.executionId).toBe(captured.hello2.executionId);
      expect(replayed.hello1.result).toEqual(captured.hello1.result);
      expect(replayed.hello2.result).toEqual(captured.hello2.result);

      // events() canonical reconstruction shape.
      expect(replayed.twoStepEvents[0]?.type).toMatch(/^(run|flow)_started$/);
      expect(replayed.twoStepEvents.at(-1)?.type).toBe("flow_completed");

      const capturedStepCompleted = captured.twoStepEvents.filter(
        (e): e is StepCompleted => e.type === "step_completed",
      );
      const replayedStepCompleted = replayed.twoStepEvents.filter(
        (e): e is StepCompleted => e.type === "step_completed",
      );
      expect(replayedStepCompleted).toHaveLength(2);

      // step_ids preserved between capture and replay (proves reconstructor
      // walks the same snapshot rows in the same order).
      expect(replayedStepCompleted.map((e) => e.stepId)).toEqual(
        capturedStepCompleted.map((e) => e.stepId),
      );

      // Step-level output fidelity: each replayed step's output payload equals
      // the captured one. step_id parity alone could pass on a refactor that
      // preserved ids while changing payloads — this nails the content too.
      //
      // Event-model note (phase-7 SSE-reconstruction design): a LIVE events()
      // stream carries each step's output on a separate `step_output` event
      // (`outputContext`), and its terminal `flow_completed` is metadata-only
      // (no `result`). Replay reconstruction deliberately collapses per-step
      // output onto `step_completed` (`output`) and surfaces the final output
      // on `flow_completed.result`. Same data, different carrier events — so
      // compare the replayed `step_completed` outputs against the captured
      // `step_output` payloads.
      const capturedStepOutputs = captured.twoStepEvents
        .filter((e) => e.type === "step_output")
        .map((e) => (e as unknown as { outputContext?: unknown }).outputContext);
      expect(capturedStepOutputs).toHaveLength(2);
      expect(replayedStepCompleted.map((e) => e.output)).toEqual(capturedStepOutputs);

      // Terminal result fidelity: replay's reconstructed `flow_completed`
      // carries the final output_snapshot as `result`; assert it matches the
      // last captured `step_output` payload (the live stream's terminal output).
      const replayedFlowCompleted = replayed.twoStepEvents.filter(
        (e): e is FlowCompleted => e.type === "flow_completed",
      );
      expect(replayedFlowCompleted.length).toBeGreaterThan(0);
      expect(replayedFlowCompleted.at(-1)?.result).toEqual(
        capturedStepOutputs.at(-1),
      );
    },
    180_000,
  );

  it(
    "events() under replay emits the canonical reconstructed sequence for a multi-block flow",
    async () => {
      const sessionId = await replayScope<string>(
        async () => {
          await collectStream(twoStepFlow(client).events({ message: "reconstruction test" }));
          const sid = currentSessionId();
          if (sid === null) throw new Error("session id null inside scope");
          return sid;
        },
        { transport: client._transport },
      );

      const replayed = await replayScope<StreamEvent[]>(
        async () =>
          collectStream(twoStepFlow(client).events({ message: "reconstruction test" })),
        { replaySessionId: sessionId, transport: client._transport },
      );

      // Canonical: starts with run_started (or legacy alias), ends with
      // flow_completed, has exactly 2 step_completed events between.
      expect(["run_started", "flow_started"]).toContain(replayed[0]?.type);
      expect(replayed.at(-1)?.type).toBe("flow_completed");
      expect(replayed.filter((e) => e.type === "step_completed")).toHaveLength(2);
    },
    180_000,
  );

  it(
    "scope close with unconsumed executions raises ReplayLeftoverError",
    async () => {
      // Capture 3 executions.
      const sessionId = await replayScope<string>(
        async () => {
          await helloFlow(client).execute({ message: "call 1" });
          await helloFlow(client).execute({ message: "call 2" });
          await helloFlow(client).execute({ message: "call 3" });
          const sid = currentSessionId();
          if (sid === null) throw new Error("session id null inside scope");
          return sid;
        },
        { transport: client._transport },
      );

      // Replay only 2 — third stays unconsumed; scope close raises.
      await expect(
        replayScope(
          async () => {
            await helloFlow(client).execute({ message: "call 1" });
            await helloFlow(client).execute({ message: "call 2" });
          },
          { replaySessionId: sessionId, transport: client._transport },
        ),
      ).rejects.toBeInstanceOf(ReplayLeftoverError);
    },
    180_000,
  );

  it(
    "replaying against a different flow slug raises ReplayMissError",
    async () => {
      // Capture against hello_flow.
      const sessionId = await replayScope<string>(
        async () => {
          await helloFlow(client).execute({ message: "recorded only against hello" });
          const sid = currentSessionId();
          if (sid === null) throw new Error("session id null inside scope");
          return sid;
        },
        { transport: client._transport },
      );

      // Replay against two_step_flow — no recording for that slug in this session.
      await expect(
        replayScope(
          async () => {
            await twoStepFlow(client).execute({ message: "wrong slug — no recording" });
          },
          { replaySessionId: sessionId, transport: client._transport },
        ),
      ).rejects.toBeInstanceOf(ReplayMissError);
    },
    180_000,
  );
});
