import { describe, it, expect } from "vitest";
import * as sdk from "../src/index.js";
import { Run } from "../src/index.js";

/**
 * Guard the trace* -> replay* rename (design 20260916-SDK-otel-and-replay-rename).
 *
 * The replay/capture scope was renamed from the misleading `trace*` names to
 * `replay*`. This locks the new public surface, asserts the old name is gone
 * (a hard rename — no deprecation alias), and confirms the neighbouring
 * execution-trace API (`run.trace`) is unaffected by the rename.
 */
describe("trace* -> replay* rename", () => {
  it("exports the new replay* names", () => {
    expect(typeof sdk.replayScope).toBe("function");
    expect(typeof sdk.currentSessionId).toBe("function");
    expect(typeof sdk.currentScope).toBe("function");
  });

  it("no longer exports the old traceScope name", () => {
    expect("traceScope" in sdk).toBe(false);
  });

  it("leaves the execution-trace API (run.trace) intact", () => {
    expect(typeof Run.prototype.trace).toBe("function");
    expect(typeof Run.prototype.stepTrace).toBe("function");
    expect(typeof Run.prototype.liveTrace).toBe("function");
  });
});
