import { describe, it, expect, vi, beforeEach } from "vitest";
import { Noukai, APITimeoutError, FlowNotFoundError } from "../src/index.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

describe("executeAsync", () => {
  it("returns Job with executionId", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      executionId: "exec-123", status: "started", flowId: "f", blockCount: 2,
    }), { status: 200 }));
    const job = await new Noukai({ apiKey: "nk_x" }).flow("a/b/c").executeAsync({ message: "hi" });
    expect(job.executionId).toBe("exec-123");
  });

  it("posts to /jobs endpoint", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      executionId: "e", status: "started", flowId: "f", blockCount: 1,
    }), { status: 200 }));
    await new Noukai({ apiKey: "nk_x" }).flow("acme/spelling/grade-3").executeAsync({ message: "hi" });
    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/seq\/acme\/spelling\/grade-3\/jobs$/);
  });
});

describe("Job.poll", () => {
  it("returns JobStatus", async () => {
    const calls: string[] = [];
    fetchSpy.mockImplementation(async (url) => {
      // Guard against Vitest's internal fetch calls (url may be undefined)
      const urlStr = typeof url === "string" ? url : "";
      calls.push(urlStr);
      if (urlStr.includes("/jobs/exec-1")) {
        return new Response(JSON.stringify({ executionId: "exec-1", status: "running" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        executionId: "exec-1", status: "started", flowId: "f", blockCount: 1,
      }), { status: 200 });
    });
    const noukai = new Noukai({ apiKey: "nk_x" });
    const job = await noukai.flow("a/b/c").executeAsync({ message: "hi" });
    const status = await job.poll();
    expect(status.status).toBe("running");
  });
});

describe("Job.wait", () => {
  it("returns when terminal", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        pollCount++;
        return new Response(JSON.stringify({
          executionId: "e",
          status: pollCount < 3 ? "running" : "completed",
          result: pollCount >= 3 ? { answer: 42 } : undefined,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        executionId: "e", status: "started", flowId: "f", blockCount: 1,
      }), { status: 200 });
    });
    const noukai = new Noukai({ apiKey: "nk_x" });
    const job = await noukai.flow("a/b/c").executeAsync({ message: "hi" });
    const promise = job.wait({ timeout: 60_000, pollInterval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const final = await promise;
    expect(final.status).toBe("completed");
    vi.useRealTimers();
  });

  it("timeout throws APITimeoutError", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ executionId: "e", status: "running" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        executionId: "e", status: "started", flowId: "f", blockCount: 1,
      }), { status: 200 });
    });
    const noukai = new Noukai({ apiKey: "nk_x" });
    const job = await noukai.flow("a/b/c").executeAsync({ message: "hi" });
    const promise = job.wait({ timeout: 500, pollInterval: 100 });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).rejects.toBeInstanceOf(APITimeoutError);
    vi.useRealTimers();
  });

  // Race: executeAsync returns the executionId to the client before the
  // orchestrator-worker has inserted the flow_runs row. A poll inside that
  // window legitimately returns 404 — we treat it as "still queued" rather
  // than a real not-found.
  it("suppresses 404 within submission grace window and resumes polling", async () => {
    vi.useFakeTimers();
    let getCount = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        getCount++;
        if (getCount === 1) {
          return new Response(
            JSON.stringify({ detail: { code: "JOB_NOT_FOUND", message: "Job not found" } }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({ executionId: "e", status: "completed", result: { ok: true } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ executionId: "e", status: "started", flowId: "f", blockCount: 1 }),
        { status: 200 },
      );
    });
    const noukai = new Noukai({ apiKey: "nk_x" });
    const job = await noukai.flow("a/b/c").executeAsync({ message: "hi" });
    const promise = job.wait({ timeout: 30_000, pollInterval: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const final = await promise;
    expect(final.status).toBe("completed");
    expect(getCount).toBe(2);
    vi.useRealTimers();
  });

  it("propagates 404 after grace window expires", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({ detail: { code: "JOB_NOT_FOUND", message: "Job not found" } }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({ executionId: "e", status: "started", flowId: "f", blockCount: 1 }),
        { status: 200 },
      );
    });
    const noukai = new Noukai({ apiKey: "nk_x" });
    const job = await noukai.flow("a/b/c").executeAsync({ message: "hi" });
    // Advance past the 5s grace window before calling wait — the first poll
    // is now outside the grace, so 404 must propagate as FlowNotFoundError.
    await vi.advanceTimersByTimeAsync(6_000);
    const promise = job.wait({ timeout: 30_000, pollInterval: 100 });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).rejects.toBeInstanceOf(FlowNotFoundError);
    vi.useRealTimers();
  });

  it("timeout fires immediately even while suppressing 404s in grace window", async () => {
    // Mirrors the failing integration test: timeout: 1 must throw
    // APITimeoutError even when the server is racing and returning 404s.
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async (_url, init) => {
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({ detail: { code: "JOB_NOT_FOUND", message: "Job not found" } }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({ executionId: "e", status: "started", flowId: "f", blockCount: 1 }),
        { status: 200 },
      );
    });
    const noukai = new Noukai({ apiKey: "nk_x" });
    const job = await noukai.flow("a/b/c").executeAsync({ message: "hi" });
    const promise = job.wait({ timeout: 1, pollInterval: 100 });
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).rejects.toBeInstanceOf(APITimeoutError);
    vi.useRealTimers();
  });
});
