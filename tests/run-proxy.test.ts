import { describe, it, expect, vi, beforeEach } from "vitest";
import { Noukai } from "../src/index.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

function tracePayload() {
  return {
    flowRun: {
      id: "run-1", flowId: "f", status: "completed",
      triggerType: "ad_hoc", stepCount: 2, durationMs: 3000,
    },
    steps: [
      { stepId: "s-1", attempt: 1, status: "completed", durationMs: 1200,
        modelUsed: "anthropic/claude-sonnet-4-6",
        tokens: { prompt: 100, completion: 50, total: 150 }, costUsd: "0.0001" },
      { stepId: "s-2", attempt: 1, status: "completed", durationMs: 1800,
        tokens: { prompt: 200, completion: 80, total: 280 }, costUsd: "0.00015" },
    ],
  };
}

describe("Run.trace()", () => {
  it("returns typed Trace", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(tracePayload()), { status: 200 }));
    const trace = await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").run("run-1").trace();
    expect(trace.flowRun.id).toBe("run-1");
    expect(trace.steps).toHaveLength(2);
  });

  it("uses slug-scoped URL", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(tracePayload()), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" }).flow("acme/spelling/grade-3").run("run-1").trace();
    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/seq\/acme\/spelling\/grade-3\/runs\/run-1\/trace$/);
  });
});

describe("Run.stepTrace()", () => {
  it("latest returns single StepTrace", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      stepId: "s-1", attempt: 2, status: "completed", durationMs: 800,
    }), { status: 200 }));
    const result = await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c").run("run-1").stepTrace("s-1");
    expect((result as any).attempt).toBe(2);
  });

  it("attempt=all returns StepAttempts", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      stepId: "s-1",
      attempts: [
        { stepId: "s-1", attempt: 1, status: "failed" },
        { stepId: "s-1", attempt: 2, status: "completed" },
      ],
    }), { status: 200 }));
    const result = await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c").run("run-1").stepTrace("s-1", { attempt: "all" });
    expect((result as any).attempts).toHaveLength(2);
  });

  it("attempt=N adds query param", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      stepId: "s-1", attempt: 2, status: "completed",
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c").run("run-1").stepTrace("s-1", { attempt: 2 });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("attempt=2");
  });

  it("loopIndex adds query param", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      stepId: "s-1", attempt: 1, status: "completed", loopIndex: 0,
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c").run("run-1").stepTrace("s-1", { loopIndex: 0 });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("loop_index=0");
  });
});

describe("Run.liveTrace()", () => {
  it("yields typed events", async () => {
    const body = (
      `data: ${JSON.stringify({ eventType: "step_started", stepId: "s-1" })}\n\n` +
      `data: ${JSON.stringify({ eventType: "step_completed", stepId: "s-1", output: { x: 1 } })}\n\n` +
      `data: ${JSON.stringify({ eventType: "flow_completed", runId: "r" })}\n\n`
    );
    fetchSpy.mockResolvedValue(new Response(body, {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    }));

    const events: any[] = [];
    for await (const e of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c").run("run-1").liveTrace()) {
      events.push(e);
    }
    expect(events.map(e => e.type)).toEqual(["step_started", "step_completed", "flow_completed"]);
  });

  it("uses slug-scoped stream URL", async () => {
    fetchSpy.mockResolvedValue(new Response("", {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    }));
    for await (const _ of new Noukai({ apiKey: "nk_x" })
      .flow("acme/spelling/grade-3").run("run-1").liveTrace()) {/* no-op */}
    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(
      /\/seq\/acme\/spelling\/grade-3\/runs\/run-1\/trace\/stream$/,
    );
  });
});
