import { describe, it, expect } from "vitest";
import {
  Noukai,
  Flow,
  Run,
  Job,
  NoukaiError,
  AuthenticationError,
  FlowExecutionError,
  ServerErrorCode,
} from "../src/index.js";

describe("public surface", () => {
  it("exports all classes", () => {
    expect(Noukai).toBeDefined();
    expect(Flow).toBeDefined();
    expect(Run).toBeDefined();
    expect(Job).toBeDefined();
  });

  it("Noukai constructor throws AuthenticationError when no key", () => {
    // Phase 4: constructor is implemented; throws AuthenticationError, not "not implemented"
    expect(() => new Noukai()).toThrow(AuthenticationError);
  });

  it("Noukai has [Symbol.asyncDispose]", () => {
    const proto = Noukai.prototype as unknown as Record<symbol, unknown>;
    expect(typeof proto[Symbol.asyncDispose]).toBe("function");
  });

  it("error hierarchy uses instanceof correctly", () => {
    const e = new AuthenticationError("bad");
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e).toBeInstanceOf(NoukaiError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AuthenticationError");
  });

  it("FlowExecutionError carries .code", () => {
    const e = new FlowExecutionError("hit limit", { code: ServerErrorCode.TOOL_ITERATION_LIMIT });
    expect(e.code).toBe("TOOL_ITERATION_LIMIT");
  });
});
