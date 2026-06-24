import { describe, it, expect } from "vitest";
import { parseSSEStream } from "../src/streaming.js";

async function* feed(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

function sseFrame(eventType: string, payload: Record<string, unknown> = {}): Uint8Array {
  const data = JSON.stringify({ eventType, ...payload });
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe("single frame parsing", () => {
  it("run_started", async () => {
    const events = await collect(
      parseSSEStream(
        feed([sseFrame("run_started", { runId: "r-1", flowId: "f", stepCount: 3 })]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run_started", runId: "r-1" });
  });

  it("step_completed with tokens", async () => {
    const events = await collect(
      parseSSEStream(
        feed([
          sseFrame("step_completed", {
            stepId: "s-1",
            name: "summarize",
            output: { summary: "..." },
            durationMs: 1240,
            tokens: { prompt: 100, completion: 50, total: 150 },
            costUsd: "0.000150",
          }),
        ]),
      ),
    );
    const e = events[0] as { type: string; tokens: { total: number } };
    expect(e.type).toBe("step_completed");
    expect(e.tokens.total).toBe(150);
  });

  it("step_paused_for_tool_calls → ToolCallsRequired with type='tool_calls_required'", async () => {
    const events = await collect(
      parseSSEStream(
        feed([
          sseFrame("step_paused_for_tool_calls", {
            runId: "r-1",
            executionId: "e-1",
            stepId: "s-1",
            stepIndex: 2,
            iterationsUsed: 1,
            toolCallMessages: [{ role: "assistant" }],
            toolCalls: [{ id: "tc-1" }],
            accumulatedOutputs: {},
          }),
        ]),
      ),
    );
    expect(events[0]).toMatchObject({ type: "tool_calls_required", executionId: "e-1" });
  });

  it("flow_started maps to run_started (legacy alias)", async () => {
    const events = await collect(
      parseSSEStream(feed([sseFrame("flow_started", { runId: "r-1", flowId: "f" })])),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run_started", runId: "r-1" });
  });

  it("flow_completed passes through", async () => {
    const events = await collect(
      parseSSEStream(feed([sseFrame("flow_completed", { runId: "r-1", result: { ok: true } })])),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "flow_completed", runId: "r-1" });
  });
});

describe("frame boundaries", () => {
  it("frames split across chunks", async () => {
    const full = sseFrame("step_completed", { stepId: "s-1", output: {} });
    const events = await collect(
      parseSSEStream(feed([full.slice(0, 5), full.slice(5, 20), full.slice(20)])),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "step_completed", stepId: "s-1" });
  });

  it("multiple frames in one chunk", async () => {
    const a = sseFrame("step_started", { stepId: "s-1" });
    const b = sseFrame("step_completed", { stepId: "s-1", output: {} });
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    const events = await collect(parseSSEStream(feed([combined])));
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("step_started");
    expect(events[1]?.type).toBe("step_completed");
  });

  it("handles trailing partial frame gracefully", async () => {
    const full = sseFrame("step_completed", { stepId: "s-1", output: {} });
    // chop off the trailing \n\n so the final frame is never flushed
    const partial = full.slice(0, full.length - 2);
    const events = await collect(parseSSEStream(feed([partial])));
    expect(events).toHaveLength(0);
  });
});

describe("robustness", () => {
  it("ignores SSE comments (lines starting with :)", async () => {
    const heartbeat = new TextEncoder().encode(": heartbeat\n\n");
    const real = sseFrame("step_completed", { stepId: "s-1", output: {} });
    const events = await collect(parseSSEStream(feed([heartbeat, real])));
    expect(events).toHaveLength(1);
  });

  it("skips unknown event types", async () => {
    const events = await collect(
      parseSSEStream(
        feed([
          sseFrame("future_event_we_dont_know"),
          sseFrame("step_completed", { stepId: "s-1", output: {} }),
        ]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("step_completed");
  });

  it("skips malformed JSON", async () => {
    const bad = new TextEncoder().encode("data: {not json}\n\n");
    const good = sseFrame("step_completed", { stepId: "s-1", output: {} });
    const events = await collect(parseSSEStream(feed([bad, good])));
    expect(events).toHaveLength(1);
  });

  it("skips frames with no data: lines", async () => {
    const empty = new TextEncoder().encode("\n\n");
    const good = sseFrame("step_completed", { stepId: "s-1", output: {} });
    const events = await collect(parseSSEStream(feed([empty, good])));
    expect(events).toHaveLength(1);
  });

  it("concatenates multi-line data: payloads with newlines (SSE spec)", async () => {
    // Per SSE spec, multi-line `data:` lines are joined with `\n` to form the
    // payload. JSON is whitespace-tolerant, so split-at-property-boundary works.
    const frame = new TextEncoder().encode(
      `data: {"eventType":"step_completed",\n` +
        `data: "stepId":"s-1","output":{}}\n\n`,
    );
    const events = await collect(parseSSEStream(feed([frame])));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("step_completed");
  });

  it("skips frames whose eventType is not a string", async () => {
    const weird = new TextEncoder().encode(
      `data: ${JSON.stringify({ eventType: 42 })}\n\n`,
    );
    const events = await collect(parseSSEStream(feed([weird])));
    expect(events).toHaveLength(0);
  });
});

describe("SSE event: field as discriminator", () => {
  // Per SSE spec, the `event:` field is the dispatch type. The parser uses
  // it as the authoritative discriminator and falls back to payload
  // `eventType` only when `event:` is absent.

  it("uses event: line when payload has no eventType", async () => {
    const frame = new TextEncoder().encode(
      `event: step_completed\ndata: ${JSON.stringify({ stepId: "s-1", output: {} })}\n\n`,
    );
    const events = await collect(parseSSEStream(feed([frame])));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "step_completed", stepId: "s-1" });
  });

  it("event: line wins when it disagrees with payload eventType", async () => {
    const frame = new TextEncoder().encode(
      `event: step_completed\ndata: ${JSON.stringify({
        eventType: "step_started",
        stepId: "s-1",
        output: {},
      })}\n\n`,
    );
    const events = await collect(parseSSEStream(feed([frame])));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("step_completed");
  });

  it("unknown event: type is dropped (forward-compat)", async () => {
    const frame = new TextEncoder().encode(
      `event: future_event_we_dont_know\ndata: {}\n\n`,
    );
    const events = await collect(parseSSEStream(feed([frame])));
    expect(events).toHaveLength(0);
  });

  it("step_paused_for_tool_calls via event: line maps to tool_calls_required", async () => {
    const frame = new TextEncoder().encode(
      `event: step_paused_for_tool_calls\ndata: ${JSON.stringify({
        runId: "r-1",
        executionId: "e-1",
        stepId: "s-1",
        stepIndex: 2,
        iterationsUsed: 1,
        toolCallMessages: [],
        toolCalls: [],
        accumulatedOutputs: {},
      })}\n\n`,
    );
    const events = await collect(parseSSEStream(feed([frame])));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_calls_required",
      executionId: "e-1",
    });
  });

  it("falls back to payload eventType when event: is absent", async () => {
    // The existing sseFrame helper emits no event: line — this is the
    // back-compat path that all the earlier tests in this file exercise.
    const frame = sseFrame("flow_completed", { runId: "r-1" });
    const events = await collect(parseSSEStream(feed([frame])));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("flow_completed");
  });
});
