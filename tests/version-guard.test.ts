import { describe, it, expect, vi } from "vitest";
import { Noukai } from "../src/index.js";

/**
 * Verifies that version="production" raises an explicit error (server prereq deferred).
 * These tests are isolated from the global fetchSpy used in execute.test.ts to avoid
 * fetch-mock interference — the guard throws before fetch is ever called.
 */
describe("version='production' guard", () => {
  it("execute() throws with clear message before fetch is called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      await expect(flow.execute({ version: "production" })).rejects.toThrow(
        /not yet supported/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("executeAsync() throws with clear message before fetch is called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      await expect(flow.executeAsync({ version: "production" })).rejects.toThrow(
        /not yet supported/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
