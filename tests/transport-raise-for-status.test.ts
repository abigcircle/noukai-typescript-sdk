/**
 * Non-raising transport mode (design 20260903-SDK-agent-relay, PR-1).
 *
 * `request(..., { raiseForStatus: false })` returns the `TransportResponse` on
 * non-2xx instead of throwing a typed error. This is the primitive the relay
 * adapter relies on to pass 4xx/5xx from the upstream `/execute` back to the
 * browser verbatim. Default (`raiseForStatus` unset / true) preserves today's
 * behavior — `transport.test.ts` is the regression guard for that.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transport } from "../src/transport.js";
import { FlowNotFoundError } from "../src/errors.js";

function makeTransport(
  overrides: Partial<ConstructorParameters<typeof Transport>[0]> = {},
) {
  return new Transport({
    apiKey: "nk_test",
    baseUrl: "https://noukai.dev/api/v1",
    timeout: 30_000,
    maxRetries: 1,
    logPayloads: false,
    ...overrides,
  });
}

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());

describe("raiseForStatus: false", () => {
  it("returns the response on non-2xx instead of throwing", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "FLOW_NOT_FOUND", message: "no" } }), {
        status: 404,
      }),
    );
    const t = makeTransport();
    const resp = await t.request("POST", "/execute", {
      json: { message: "hi" },
      raiseForStatus: false,
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.body).toEqual({ detail: { code: "FLOW_NOT_FOUND", message: "no" } });
  });

  it("returns 5xx verbatim when not raising (retries exhausted first)", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ detail: "down" }), { status: 503 }));
    // maxRetries: 0 so the single reused mock Response is not consumed twice.
    const t = makeTransport({ maxRetries: 0 });
    const resp = await t.request("POST", "/execute", { json: { m: 1 }, raiseForStatus: false });
    expect(resp.statusCode).toBe(503);
    expect(resp.body).toEqual({ detail: "down" });
  });

  it("non-JSON body is passed through as raw text (transport does not force null)", async () => {
    // TS `safeJson` returns the raw text when JSON.parse fails (Python returns
    // None). The relay layer normalizes both to UPSTREAM_NON_JSON — see the
    // relay adapter tests. Here we pin the transport's own behavior.
    fetchSpy.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const t = makeTransport({ maxRetries: 0 });
    const resp = await t.request("POST", "/execute", { json: { m: 1 }, raiseForStatus: false });
    expect(resp.statusCode).toBe(502);
    expect(resp.body).toBe("<html>Bad Gateway</html>");
  });

  it("2xx unaffected by the flag", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const t = makeTransport();
    const resp = await t.request("POST", "/execute", { json: { m: 1 }, raiseForStatus: false });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toEqual({ ok: true });
  });

  it("default (flag unset) still throws typed error", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "FLOW_NOT_FOUND", message: "no" } }), {
        status: 404,
      }),
    );
    const t = makeTransport();
    await expect(t.request("POST", "/execute", { json: { m: 1 } })).rejects.toBeInstanceOf(
      FlowNotFoundError,
    );
  });

  it("still retries a retryable status before the non-raising early return", async () => {
    // Counter-based mockImplementation gives a fresh Response per call (a reused
    // Response body can only be read once, and it survives the retry).
    let n = 0;
    fetchSpy.mockImplementation(() => {
      n++;
      return Promise.resolve(
        n === 1
          ? new Response(JSON.stringify({ detail: "down" }), { status: 503 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    });
    const t = makeTransport({ maxRetries: 1 });
    // GET is retryable; the retry runs, then the 200 is returned (not the 503).
    const resp = await t.request("GET", "/x", { raiseForStatus: false });
    expect(n).toBe(2);
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toEqual({ ok: true });
  });

  // Connection/timeout errors are caught at `await fetch` — before the
  // raiseForStatus check — so the flag cannot swallow them. That wrapping
  // (TypeError → APIConnectionError) is already covered by transport.test.ts's
  // "connection errors" suite, so it is not duplicated here.
});
