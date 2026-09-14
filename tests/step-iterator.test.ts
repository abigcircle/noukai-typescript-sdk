import { describe, it, expect, vi, beforeEach } from "vitest";
import { Noukai, ToolCallLimitError } from "../src/index.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

function sseResponse(...events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {};
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("simple step flow — steps()", () => {
  it("yields one StepCompleted per finished step", async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      callCount++;
      const body = parseBody(init);
      const stepIndex = body.stepIndex ?? 0;
      if (stepIndex === 0) {
        return sseResponse(
          { eventType: "run_started", runId: "r", executionId: "e", flowId: "f", stepCount: 2 },
          { eventType: "step_started", stepId: "s-1" },
          { eventType: "step_completed", stepId: "s-1", name: "a", output: { x: 1 } },
          { eventType: "step_paused", stepId: "s-1", stepIndex: 1 },
        );
      }
      return sseResponse(
        { eventType: "step_started", stepId: "s-2" },
        { eventType: "step_completed", stepId: "s-2", name: "b", output: { y: 2 } },
        { eventType: "flow_completed", runId: "r", executionId: "e", result: { final: true } },
      );
    });

    const steps: { name?: string }[] = [];
    for await (const step of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .steps({ message: "hi" })) {
      steps.push(step);
    }
    expect(steps.map((s) => s.name)).toEqual(["a", "b"]);
    expect(callCount).toBe(2);
  });

  it("steps() filters out non-StepCompleted events", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse(
        { eventType: "run_started", runId: "r", executionId: "e", flowId: "f", stepCount: 1 },
        { eventType: "step_started", stepId: "s-1" },
        { eventType: "step_input", stepId: "s-1", inputData: { x: 1 } },
        { eventType: "step_completed", stepId: "s-1", name: "only", output: { ok: true } },
        { eventType: "flow_completed", runId: "r" },
      ),
    );
    const steps: { name?: string }[] = [];
    for await (const step of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .steps({ message: "hi" })) {
      steps.push(step);
    }
    expect(steps).toHaveLength(1);
    expect(steps[0]?.name).toBe("only");
  });
});

describe("cursor management", () => {
  it("executionId and accumulatedOutputs carried across /step calls", async () => {
    const bodies: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = parseBody(init);
      bodies.push(body);
      if ((body.stepIndex ?? 0) === 0) {
        return sseResponse(
          {
            eventType: "run_started",
            executionId: "exec-xyz",
            runId: "r",
            flowId: "f",
            stepCount: 2,
          },
          { eventType: "step_completed", stepId: "s-1", output: { a: 1 } },
          { eventType: "step_paused", stepId: "s-1", stepIndex: 1 },
        );
      }
      return sseResponse(
        { eventType: "step_completed", stepId: "s-2", output: { b: 2 } },
        { eventType: "flow_completed", runId: "r" },
      );
    });
    for await (const _ of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .steps({ message: "hi" })) {
      /* drain */
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.executionId).toBe("exec-xyz");
    const acc = bodies[1]?.accumulatedOutputs as Record<string, unknown>;
    expect(acc["s-1"]).toEqual({ a: 1 });
    expect(bodies[1]?.stepIndex).toBe(1);
  });

  it("message only sent on first /step call (subsequent calls send null)", async () => {
    const bodies: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = parseBody(init);
      bodies.push(body);
      if ((body.stepIndex ?? 0) === 0) {
        return sseResponse(
          { eventType: "run_started", executionId: "e", runId: "r", flowId: "f", stepCount: 2 },
          { eventType: "step_completed", stepId: "s-1", output: { a: 1 } },
          { eventType: "step_paused", stepId: "s-1", stepIndex: 1 },
        );
      }
      return sseResponse(
        { eventType: "step_completed", stepId: "s-2", output: { b: 2 } },
        { eventType: "flow_completed", runId: "r" },
      );
    });
    for await (const _ of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .steps({ message: "hello-world" })) {
      /* drain */
    }
    expect(bodies[0]?.message).toBe("hello-world");
    expect(bodies[1]?.message).toBeNull();
  });
});

describe("events() raw mode", () => {
  it("yields every event in order", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse(
        { eventType: "run_started", executionId: "e", runId: "r", flowId: "f", stepCount: 1 },
        { eventType: "step_started", stepId: "s-1" },
        { eventType: "step_input", stepId: "s-1", inputData: { x: 1 } },
        { eventType: "step_output", stepId: "s-1", outputData: "partial" },
        { eventType: "step_completed", stepId: "s-1", output: "final" },
        { eventType: "flow_completed", runId: "r" },
      ),
    );
    const events: { type: string }[] = [];
    for await (const e of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .events({ message: "hi", runRemaining: true })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "step_started",
      "step_input",
      "step_output",
      "step_completed",
      "flow_completed",
    ]);
  });

  it("runRemaining flag passes through to /step body", async () => {
    const bodies: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      bodies.push(parseBody(init));
      return sseResponse({ eventType: "flow_completed", runId: "r" });
    });
    for await (const _ of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .events({ message: "hi", runRemaining: true })) {
      /* drain */
    }
    expect(bodies[0]?.runRemaining).toBe(true);
  });

  it("events() includes step_paused", async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return sseResponse(
          { eventType: "run_started", executionId: "e", runId: "r", flowId: "f", stepCount: 2 },
          { eventType: "step_completed", stepId: "s-1", output: {} },
          { eventType: "step_paused", stepId: "s-1", stepIndex: 1 },
        );
      }
      return sseResponse(
        { eventType: "step_completed", stepId: "s-2", output: {} },
        { eventType: "flow_completed", runId: "r" },
      );
    });
    const events: { type: string }[] = [];
    for await (const e of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .events({ message: "hi" })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "step_paused")).toBe(true);
    expect(events.some((e) => e.type === "flow_completed")).toBe(true);
  });
});

describe("tool calls in iterator", () => {
  it("toolHandler auto-resumes (no ToolCallsRequired surfaced)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const handlerCalls: Record<string, unknown>[][] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      bodies.push(parseBody(init));
      if (bodies.length === 1) {
        return sseResponse(
          { eventType: "run_started", executionId: "e", runId: "r", flowId: "f", stepCount: 1 },
          { eventType: "step_started", stepId: "s-1" },
          {
            eventType: "step_paused_for_tool_calls",
            runId: "r",
            executionId: "e",
            stepId: "s-1",
            stepIndex: 0,
            iterationsUsed: 1,
            toolCallMessages: [{ role: "assistant" }],
            toolCalls: [{ id: "tc-1" }],
            accumulatedOutputs: {},
          },
        );
      }
      return sseResponse(
        { eventType: "step_completed", stepId: "s-1", output: { x: 1 } },
        { eventType: "flow_completed", runId: "r" },
      );
    });
    const events: { type: string }[] = [];
    for await (const e of new Noukai({ apiKey: "nk_x" }).flow("a/b/c").events({
      message: "hi",
      tools: [{}],
      toolHandler: (calls) => {
        handlerCalls.push(calls);
        return calls.map((tc) => ({
          role: "tool",
          toolCallId: (tc as { id: string }).id,
          content: "ok",
        }));
      },
    })) {
      events.push(e);
    }
    expect(handlerCalls).toHaveLength(1);
    expect(events.some((e) => e.type === "tool_calls_required")).toBe(false);
    expect(events.some((e) => e.type === "step_completed")).toBe(true);

    // Second body should carry tool messages
    const second = bodies[1] ?? {};
    const tcm = second.toolCallMessages as unknown[];
    expect(Array.isArray(tcm)).toBe(true);
    expect(tcm.length).toBeGreaterThan(1);
  });

  it("no handler → yields ToolCallsRequired with .resume()", async () => {
    const bodies: Record<string, unknown>[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      bodies.push(parseBody(init));
      if (bodies.length === 1) {
        return sseResponse(
          { eventType: "run_started", executionId: "e", runId: "r", flowId: "f", stepCount: 1 },
          {
            eventType: "step_paused_for_tool_calls",
            runId: "r",
            executionId: "e",
            stepId: "s-1",
            stepIndex: 0,
            iterationsUsed: 1,
            toolCallMessages: [{ role: "assistant" }],
            toolCalls: [{ id: "tc-1" }],
            accumulatedOutputs: {},
          },
        );
      }
      return sseResponse(
        { eventType: "step_completed", stepId: "s-1", output: { x: 1 } },
        { eventType: "flow_completed", runId: "r" },
      );
    });
    const events: { type: string }[] = [];
    for await (const e of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .events({ message: "hi", tools: [{}] })) {
      if (e.type === "tool_calls_required") {
        await e.resume({
          toolResults: [{ role: "tool", toolCallId: "tc-1", content: "ok" }],
        });
      }
      events.push(e);
    }
    expect(events.some((e) => e.type === "tool_calls_required")).toBe(true);
    expect(events.some((e) => e.type === "step_completed")).toBe(true);

    // Body 2 (after resume) carries tool results
    const second = bodies[1] ?? {};
    const tcm = second.toolCallMessages as Record<string, unknown>[];
    expect(tcm.some((m) => m.role === "tool" && m.toolCallId === "tc-1")).toBe(true);
  });

  it("maxToolRounds throws ToolCallLimitError", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse({
        eventType: "step_paused_for_tool_calls",
        runId: "r",
        executionId: "e",
        stepId: "s-1",
        stepIndex: 0,
        iterationsUsed: 1,
        toolCallMessages: [{ role: "assistant" }],
        toolCalls: [{ id: "tc-1" }],
        accumulatedOutputs: {},
      }),
    );

    const iter = new Noukai({ apiKey: "nk_x" }).flow("a/b/c").events({
      message: "hi",
      tools: [{}],
      maxToolRounds: 2,
      toolHandler: (calls) =>
        calls.map((tc) => ({
          role: "tool",
          toolCallId: (tc as { id: string }).id,
          content: "ok",
        })),
    });

    const consume = async (): Promise<void> => {
      for await (const _ of iter) {
        /* drain */
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ToolCallLimitError);
  });
});

describe("step_error termination", () => {
  it("yields step_error then ends iteration", async () => {
    fetchSpy.mockImplementation(async () =>
      sseResponse(
        { eventType: "run_started", executionId: "e", runId: "r", flowId: "f", stepCount: 1 },
        { eventType: "step_error", stepId: "s-1", error: { code: "INTERNAL_ERROR" } },
      ),
    );
    const events: { type: string }[] = [];
    for await (const e of new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .events({ message: "hi" })) {
      events.push(e);
    }
    // run_started + step_error
    expect(events.map((e) => e.type)).toEqual(["run_started", "step_error"]);
  });
});

function urlString(input: string | URL | Request | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("URL construction", () => {
  it("posts to /step path with versionedPath", async () => {
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (url) => {
      urls.push(urlString(url));
      return sseResponse({ eventType: "flow_completed", runId: "r" });
    });
    for await (const _ of new Noukai({ apiKey: "nk_x" })
      .flow("org/proj/slug")
      .events({ message: "hi" })) {
      /* drain */
    }
    expect(urls[0]).toMatch(/\/seq\/org\/proj\/slug\/step$/);
  });

  it("integer version → /vN/step", async () => {
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (url) => {
      urls.push(urlString(url));
      return sseResponse({ eventType: "flow_completed", runId: "r" });
    });
    for await (const _ of new Noukai({ apiKey: "nk_x" })
      .flow("o/p/s")
      .events({ message: "hi", version: 3 })) {
      /* drain */
    }
    expect(urls[0]).toMatch(/\/seq\/o\/p\/s\/v3\/step$/);
  });
});
