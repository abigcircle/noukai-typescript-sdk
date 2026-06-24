import { describe, it, expect } from "vitest";
import type {
  ExecuteRequest,
  StepRequest,
  ExecuteResult,
  PausedResult,
  JobStatus,
  StreamEvent,
  StepCompleted,
  ToolCallsRequired,
  Trace,
  StepTrace,
} from "../src/index.js"; // populated Phase 2 — this test will fail until Phase 2 lands.

describe("type surface compiles", () => {
  it("ExecuteRequest accepts minimal shape", () => {
    const req: ExecuteRequest = { message: "hi" };
    expect(req.message).toBe("hi");
  });

  it("StreamEvent narrows on type discriminator", () => {
    const event = { type: "step_completed", stepId: "s-1" } as StreamEvent;
    if (event.type === "step_completed") {
      const _name: string | undefined = event.name; // narrowing works
      expect(event.stepId).toBe("s-1");
    }
  });
});
