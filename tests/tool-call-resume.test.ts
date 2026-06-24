import { describe, it, expect, vi, beforeEach } from "vitest";
import { Noukai, FlowExecutionError, ToolCallLimitError } from "../src/index.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

function pausedPayload({ iterations = 1, toolId = "tc-1" } = {}) {
  return {
    status: "tool_calls_required",
    executionId: "exec-1",
    pausedAtStep: "step-1",
    iterationsUsed: iterations,
    toolCallMessages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: toolId, function: { name: "search", arguments: "{}" } }] },
    ],
    toolCalls: [{ id: toolId, function: { name: "search", arguments: "{}" } }],
    accumulatedOutputs: { "step-0": { context: "..." } },
    flowId: "f",
    blockCount: 2,
  };
}

function completedPayload() {
  return {
    status: "completed",
    result: { answer: "found" },
    flowId: "f",
    blockCount: 2,
    executionId: "exec-1",
  };
}

describe("manual resume", () => {
  it("PausedResult has resume() method", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(pausedPayload()), { status: 200 }));
    const result = await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .execute({ message: "hi", tools: [{ type: "function", function: { name: "search" } }] });
    expect(result.requiresToolCalls).toBe(true);
    expect(typeof (result as any).resume).toBe("function");
  });

  it("resume sends tool results", async () => {
    const bodies: any[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      // Guard against body-less internal fetch calls from the test runner.
      if (!init?.body) return new Response("{}", { status: 200 });
      bodies.push(JSON.parse(init.body as string));
      if (bodies.length === 1) return new Response(JSON.stringify(pausedPayload()), { status: 200 });
      return new Response(JSON.stringify(completedPayload()), { status: 200 });
    });
    const paused = await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .execute({ message: "hi", tools: [{ type: "function" }] });
    expect(paused.requiresToolCalls).toBe(true);
    const final = await (paused as any).resume({
      toolResults: [{ role: "tool", tool_call_id: "tc-1", content: "result" }],
    });
    expect(final.requiresToolCalls).toBe(false);
    const second = bodies[1];
    expect(second.executionId).toBe("exec-1");
    expect(second.pausedAtStep).toBe("step-1");
    expect(second.iterationsUsed).toBe(1);
    expect(second.toolCallMessages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "tc-1" });
  });

  it("resume can yield another paused", async () => {
    const responses = [
      pausedPayload({ iterations: 1, toolId: "tc-1" }),
      pausedPayload({ iterations: 2, toolId: "tc-2" }),
      completedPayload(),
    ];
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );
    const first = await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c").execute({ message: "hi", tools: [{}] });
    expect(first.requiresToolCalls).toBe(true);
    const second = await (first as any).resume({
      toolResults: [{ role: "tool", tool_call_id: "tc-1", content: "x" }],
    });
    expect(second.requiresToolCalls).toBe(true);
    const third = await (second as any).resume({
      toolResults: [{ role: "tool", tool_call_id: "tc-2", content: "y" }],
    });
    expect(third.requiresToolCalls).toBe(false);
  });
});

describe("auto resume (toolHandler)", () => {
  it("invokes handler once then completes", async () => {
    const handlerCalls: any[] = [];
    const responses = [pausedPayload(), completedPayload()];
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );

    const result = await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({
      message: "hi",
      tools: [{ type: "function", function: { name: "search" } }],
      toolHandler: (toolCalls) => {
        handlerCalls.push(toolCalls);
        return toolCalls.map((tc: any) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
      },
    });
    expect(result.requiresToolCalls).toBe(false);
    expect(handlerCalls).toHaveLength(1);
  });

  it("loops through multiple pauses", async () => {
    const handlerCalls: any[] = [];
    const responses = [
      pausedPayload({ iterations: 1, toolId: "tc-1" }),
      pausedPayload({ iterations: 2, toolId: "tc-2" }),
      pausedPayload({ iterations: 3, toolId: "tc-3" }),
      completedPayload(),
    ];
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );
    const result = await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({
      message: "hi", tools: [{}],
      toolHandler: (calls) => {
        handlerCalls.push(calls);
        return calls.map((tc: any) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
      },
    });
    expect(result.requiresToolCalls).toBe(false);
    expect(handlerCalls).toHaveLength(3);
  });

  it("async handler awaited", async () => {
    const responses = [pausedPayload(), completedPayload()];
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );
    const result = await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({
      message: "hi", tools: [{}],
      toolHandler: async (calls) =>
        calls.map((tc: any) => ({ role: "tool", tool_call_id: tc.id, content: "ok" })),
    });
    expect(result.requiresToolCalls).toBe(false);
  });

  it("maxToolRounds throws ToolCallLimitError", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(pausedPayload()), { status: 200 }),
    );
    await expect(
      new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({
        message: "hi", tools: [{}], maxToolRounds: 3,
        toolHandler: (calls) =>
          calls.map((tc: any) => ({ role: "tool", tool_call_id: tc.id, content: "ok" })),
      }),
    ).rejects.toBeInstanceOf(ToolCallLimitError);
  });

  it("server's TOOL_ITERATION_LIMIT propagates with code", async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify(pausedPayload()), { status: 200 });
      return new Response(JSON.stringify({
        detail: { code: "TOOL_ITERATION_LIMIT", message: "limit hit" },
      }), { status: 409 });
    });
    try {
      await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({
        message: "hi", tools: [{}], maxToolRounds: 10,
        toolHandler: (cs) => cs.map((tc: any) => ({ role: "tool", tool_call_id: tc.id, content: "x" })),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FlowExecutionError);
      expect((e as FlowExecutionError).code).toBe("TOOL_ITERATION_LIMIT");
    }
  });
});
