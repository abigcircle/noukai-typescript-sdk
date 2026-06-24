import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Noukai } from "../src/index.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

describe("execute URL routing", () => {
  // Isolate from shell/.env NOUKAI_ENV so origin-pinning assertions are deterministic.
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NOUKAI_ENV;
  });
  afterEach(() => { process.env = originalEnv; });

  it("draft → unversioned URL", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: "completed", flowId: "f", blockCount: 1, result: {},
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" }).flow("acme/spelling/grade-3").execute({ message: "hi" });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    // The full URL must include /api/v1/ prefix and end at /execute with no version segment.
    expect(url).toMatch(/\/api\/v1\/seq\/acme\/spelling\/grade-3\/execute$/);
  });

  it("full URL includes /api/v1/ path — regression guard", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: "completed", flowId: "f", blockCount: 1, result: {},
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" }).flow("acme/spelling/grade-3").execute({ message: "hi" });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    // Ensure the origin is followed immediately by /api/v1/seq/... not /seq/...
    expect(url).toMatch(/^https:\/\/api\.noukai\.xyz\/api\/v1\/seq\//);
  });

  it("integer version → /vN/execute URL", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: "completed", flowId: "f", blockCount: 1,
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({ message: "hi", version: 3 });
    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/v3\/execute$/);
  });
});

describe("execute request body", () => {
  it("camelCase aliases preserved", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: "completed", flowId: "f", blockCount: 1,
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({
      message: "hi",
      parameters: { foo: "bar" },
      blockOverrides: { "step-1": { model: "anthropic/claude-haiku-4-5" } },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toBe("hi");
    expect(body.parameters).toEqual({ foo: "bar" });
    expect(body.blockOverrides["step-1"].model).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("execute response parsing", () => {
  it("completed → ExecuteResult", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: "completed", result: { answer: 42 }, flowId: "f-xyz", blockCount: 3,
    }), { status: 200 }));
    const result = await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({ message: "hi" });
    expect(result.requiresToolCalls).toBe(false);
    expect((result as any).result).toEqual({ answer: 42 });
    expect((result as any).flowId).toBe("f-xyz");
  });

  it("paused → PausedResult", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: "tool_calls_required",
      executionId: "exec-1",
      pausedAtStep: "step-1",
      iterationsUsed: 1,
      toolCallMessages: [{ role: "assistant" }],
      toolCalls: [{ id: "tc-1", function: { name: "search" } }],
      accumulatedOutputs: {},
      flowId: "f",
      blockCount: 2,
    }), { status: 200 }));
    const result = await new Noukai({ apiKey: "nk_x" })
      .flow("a/b/c")
      .execute({ message: "hi", tools: [{ type: "function" }] });
    expect(result.requiresToolCalls).toBe(true);
    expect((result as any).toolCalls[0].function.name).toBe("search");
  });
});
