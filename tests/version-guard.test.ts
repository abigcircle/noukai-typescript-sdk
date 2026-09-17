import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Noukai } from "../src/index.js";

/**
 * Version routing (design 20260917-SDK-version-production-routing).
 *
 * The server routes versions by URL path:
 *   - base path (no segment) → production (draft/live fallback if unpublished)
 *   - /v0                     → draft (reserved alias; rejected on /step)
 *   - /vN (N≥1)              → published version N
 *
 * Default is "production". `version:"production"` used to throw — it no longer
 * does; it routes to the base path.
 */
describe("version routing", () => {
  const originalEnv = { ...process.env };
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env = { ...originalEnv };
    delete process.env.NOUKAI_ENV;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  const ok = () =>
    new Response(JSON.stringify({ status: "completed", flowId: "f", blockCount: 1, result: {} }), {
      status: 200,
    });

  describe("execute()", () => {
    it("version:'production' no longer throws — routes to the base path", async () => {
      fetchSpy.mockResolvedValue(ok());
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      await expect(flow.execute({ message: "hi", version: "production" })).resolves.toBeDefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/seq\/a\/b\/c\/execute$/);
    });

    it("version:'draft' → /v0/execute", async () => {
      fetchSpy.mockResolvedValue(ok());
      await new Noukai({ apiKey: "nk_x" })
        .flow("a/b/c")
        .execute({ message: "hi", version: "draft" });
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/v0\/execute$/);
    });

    it("integer 0 → /v0/execute (equivalent to draft)", async () => {
      fetchSpy.mockResolvedValue(ok());
      await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").execute({ message: "hi", version: 0 });
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/v0\/execute$/);
    });

    it("negative / non-integer version throws before fetch", async () => {
      fetchSpy.mockResolvedValue(ok());
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      await expect(flow.execute({ message: "hi", version: -1 })).rejects.toThrow(/Invalid version/);
      await expect(flow.execute({ message: "hi", version: 1.5 })).rejects.toThrow(
        /Invalid version/,
      );
      // NaN is not an integer → Number.isInteger(NaN) === false → rejected.
      await expect(flow.execute({ message: "hi", version: NaN })).rejects.toThrow(
        /Invalid version/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("executeAsync()", () => {
    it("version:'production' no longer throws — routes to base /jobs path", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ executionId: "e1", flowId: "f" }), { status: 202 }),
      );
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      await expect(
        flow.executeAsync({ message: "hi", version: "production" }),
      ).resolves.toBeDefined();
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/seq\/a\/b\/c\/jobs$/);
    });

    it("version:'draft' → /v0/jobs", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ executionId: "e1", flowId: "f" }), { status: 202 }),
      );
      await new Noukai({ apiKey: "nk_x" })
        .flow("a/b/c")
        .executeAsync({ message: "hi", version: "draft" });
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/v0\/jobs$/);
    });
  });

  describe("steps()/events() reject draft (server 400s on /v0/step)", () => {
    it("steps({version:'draft'}) throws synchronously and never opens a stream", () => {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      expect(() => flow.steps({ message: "hi", version: "draft" })).toThrow(
        /step-through on draft/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("steps({version:0}) throws too (0 is the draft alias)", () => {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      expect(() => flow.steps({ message: "hi", version: 0 })).toThrow(/step-through on draft/);
    });

    it("events({version:'draft'}) throws synchronously", () => {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      expect(() => flow.events({ message: "hi", version: "draft" })).toThrow(
        /step-through on draft/,
      );
    });

    it("steps() with default (production) does NOT throw", () => {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      expect(() => flow.steps({ message: "hi" })).not.toThrow();
    });

    it("steps({version:3}) does NOT throw", () => {
      const flow = new Noukai({ apiKey: "nk_x" }).flow("a/b/c");
      expect(() => flow.steps({ message: "hi", version: 3 })).not.toThrow();
    });
  });
});
