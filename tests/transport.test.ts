import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "../src/transport.js";
import { VERSION } from "../src/version.js";
import {
  AuthenticationError,
  FlowNotFoundError,
  RateLimitError,
  InsufficientCreditsError,
  PermissionDeniedError,
  FlowExecutionError,
  APIConnectionError,
  APITimeoutError,
} from "../src/errors.js";

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

beforeEach(() => {
  fetchSpy.mockReset();
});

afterEach(() => {
  fetchSpy.mockReset();
});

describe("headers", () => {
  it("sets Authorization Bearer header", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/health");
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer nk_test");
  });

  it("sets X-Noukai-API-Version header", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/health");
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Headers).get("X-Noukai-API-Version")).toBe("2026-05-31");
  });

  it("User-Agent includes SDK version + runtime", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/health");
    const init = fetchSpy.mock.calls[0]?.[1];
    const ua = (init?.headers as Headers).get("User-Agent") ?? "";
    expect(ua).toContain(`@noukai/sdk@${VERSION}`);
    expect(ua).toMatch(/node|bun|deno|workerd|edge|browser/);
  });
});

describe("request ID", () => {
  it("captures X-Request-ID from response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("{}", { status: 200, headers: { "X-Request-ID": "req-abc" } }),
    );
    const t = makeTransport();
    const resp = await t.request("GET", "/x");
    expect(resp.requestId).toBe("req-abc");
  });

  it("propagates X-Request-ID into the thrown exception", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "FLOW_NOT_FOUND", message: "nope" } }), {
        status: 404,
        headers: { "X-Request-ID": "req-xyz" },
      }),
    );
    const t = makeTransport();
    await expect(t.request("GET", "/x")).rejects.toMatchObject({
      requestId: "req-xyz",
    });
  });
});

describe("retries", () => {
  it("retries 5xx once by default", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const t = makeTransport();
    const resp = await t.request("GET", "/x");
    expect(resp.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry 4xx", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: "nope" }), { status: 404 }),
    );
    const t = makeTransport();
    await expect(t.request("GET", "/x")).rejects.toBeInstanceOf(FlowNotFoundError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("exponential backoff: 1s, 4s, 16s", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(new Response("err", { status: 503 }));
    const t = makeTransport({ maxRetries: 3 });

    const promise = t.request("GET", "/x");
    promise.catch(() => undefined); // suppress unhandled

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(16000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    await expect(promise).rejects.toBeInstanceOf(FlowExecutionError);
    vi.useRealTimers();
  });
});

describe("exception mapping", () => {
  it.each<[number, string, typeof FlowNotFoundError]>([
    [401, "UNAUTHENTICATED", AuthenticationError],
    [402, "INSUFFICIENT_CREDITS", InsufficientCreditsError],
    [402, "CREDITS_EXHAUSTED", InsufficientCreditsError],
    [403, "FORBIDDEN", PermissionDeniedError],
    [404, "FLOW_NOT_FOUND", FlowNotFoundError],
    [429, "RATE_LIMIT", RateLimitError],
    [500, "INTERNAL_ERROR", FlowExecutionError],
    [502, "BYOK_KEY_REJECTED", FlowExecutionError],
  ])("status %i %s → %s", async (status, code, ErrorCls) => {
    // Use mockImplementation so each call gets a fresh Response (body can only be read once).
    // Use maxRetries: 0 so retryable statuses (429, 5xx) throw immediately without sleeping.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: { code, message: "x" } }), { status }),
      ),
    );
    const t = makeTransport({ maxRetries: 0 });
    await expect(t.request("GET", "/x")).rejects.toBeInstanceOf(ErrorCls);
    await expect(t.request("GET", "/x")).rejects.toMatchObject({ statusCode: status, code });
  });

  it("captures Retry-After on 429", async () => {
    // Use maxRetries: 0 so the 429 throws immediately without sleeping.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: "slow" }), {
        status: 429,
        headers: { "Retry-After": "5" },
      }),
    );
    const t = makeTransport({ maxRetries: 0 });
    await expect(t.request("GET", "/x")).rejects.toMatchObject({ retryAfter: 5 });
  });
});

describe("connection errors", () => {
  it("TypeError (fetch network failure) → APIConnectionError", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    const t = makeTransport();
    await expect(t.request("GET", "/x")).rejects.toBeInstanceOf(APIConnectionError);
  });

  it("AbortError (timeout) → APITimeoutError", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    fetchSpy.mockRejectedValue(abortErr);
    const t = makeTransport();
    await expect(t.request("GET", "/x", { timeout: 100 })).rejects.toBeInstanceOf(APITimeoutError);
  });
});

describe("log handler", () => {
  it("invokes onLog at request and response phases", async () => {
    const events: unknown[] = [];
    fetchSpy.mockResolvedValue(
      new Response("{}", { status: 200, headers: { "X-Request-ID": "r1" } }),
    );
    const t = makeTransport({ onLog: (e) => events.push(e) });
    await t.request("GET", "/x");
    const phases = events.map((e) => (e as { phase: string }).phase);
    expect(phases).toContain("request");
    expect(phases).toContain("response");
  });

  it("omits payloads by default", async () => {
    const events: unknown[] = [];
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ secret: "data" }), { status: 200 }));
    const t = makeTransport({ onLog: (e) => events.push(e) });
    await t.request("POST", "/x", { json: { input: "secret-input" } });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("secret-input");
  });

  it("includes payloads when logPayloads=true", async () => {
    const events: unknown[] = [];
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport({ onLog: (e) => events.push(e), logPayloads: true });
    await t.request("POST", "/x", { json: { msg: "hello" } });
    const req = events.find((e) => (e as { phase: string }).phase === "request");
    expect((req as { requestBody?: { msg: string } }).requestBody).toEqual({ msg: "hello" });
  });
});

describe("stream", () => {
  it("yields chunks from a streaming response", async () => {
    const encoder = new TextEncoder();
    const chunk1 = encoder.encode("data: hello\n");
    const chunk2 = encoder.encode("data: world\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    const t = makeTransport();
    const chunks: Uint8Array[] = [];
    for await (const chunk of t.stream("POST", "/sse")) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
  });

  it("throws FlowNotFoundError on 404 during stream", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "FLOW_NOT_FOUND", message: "nope" } }), {
        status: 404,
      }),
    );
    const t = makeTransport();
    await expect(
      (async () => {
        for await (const _ of t.stream("POST", "/sse")) {
          // exhaust
        }
      })(),
    ).rejects.toBeInstanceOf(FlowNotFoundError);
  });

  it("throws APITimeoutError on AbortError during stream", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    fetchSpy.mockRejectedValue(abortErr);
    const t = makeTransport();
    await expect(
      (async () => {
        for await (const _ of t.stream("POST", "/sse")) {
          // exhaust
        }
      })(),
    ).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("throws APIConnectionError on TypeError during stream", async () => {
    fetchSpy.mockRejectedValue(new TypeError("network error"));
    const t = makeTransport();
    await expect(
      (async () => {
        for await (const _ of t.stream("POST", "/sse")) {
          // exhaust
        }
      })(),
    ).rejects.toBeInstanceOf(APIConnectionError);
  });
});

describe("close", () => {
  it("resolves without error", async () => {
    const t = makeTransport();
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe("URL resolution", () => {
  it("prepends path with base URL", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport({ baseUrl: "https://noukai.dev/api/v1" });
    await t.request("GET", "/seq/acme/spelling/grade-3/execute");
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://noukai.dev/api/v1/seq/acme/spelling/grade-3/execute");
  });

  it("avoids double slash", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport({ baseUrl: "https://noukai.dev/api/v1/" });
    await t.request("GET", "/health");
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).not.toContain("//health");
  });

  it("appends query params when provided", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/health", { params: { version: "2", format: "json" } });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("?");
    expect(url).toContain("version=2");
    expect(url).toContain("format=json");
  });
});

describe("stream extras", () => {
  it("logs request body when logPayloads=true on stream", async () => {
    const events: unknown[] = [];
    const encoder = new TextEncoder();
    const body = encoder.encode("data: ok\n");
    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    fetchSpy.mockResolvedValue(new Response(readableStream, { status: 200 }));
    const t = makeTransport({ onLog: (e) => events.push(e), logPayloads: true });
    for await (const _ of t.stream("POST", "/sse", { json: { prompt: "hello" } })) {
      // consume
    }
    const req = events.find((e) => (e as { phase: string }).phase === "request");
    expect((req as { requestBody?: unknown }).requestBody).toEqual({ prompt: "hello" });
  });

  it("handles resp.body === null gracefully", async () => {
    // Simulate a response with no body (e.g. 204 No Content with stream)
    const resp = new Response(null, { status: 200 });
    fetchSpy.mockResolvedValue(resp);
    const t = makeTransport();
    const chunks: Uint8Array[] = [];
    for await (const chunk of t.stream("GET", "/sse")) {
      chunks.push(chunk);
    }
    // Should complete with zero chunks
    expect(chunks).toHaveLength(0);
  });
});

describe("log hook error handling", () => {
  it("swallows errors thrown from onLog hook", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport({
      onLog: () => {
        throw new Error("log hook exploded");
      },
    });
    // Should not throw even if the hook throws
    await expect(t.request("GET", "/health")).resolves.toBeDefined();
  });
});

describe("signal handling", () => {
  it("respects clientSignal for cancellation", async () => {
    const clientController = new AbortController();
    clientController.abort();
    // The fetch is mocked to throw AbortError to simulate the abort propagating
    fetchSpy.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const t = makeTransport({ clientSignal: clientController.signal });
    await expect(t.request("GET", "/x")).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("uses per-call signal when provided", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchSpy.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const t = makeTransport();
    await expect(
      t.request("GET", "/x", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(APITimeoutError);
  });
});

// ---------------------------------------------------------------------------
// extraHeaders: reserved-key guard
// ---------------------------------------------------------------------------

describe("extraHeaders reserved-key guard", () => {
  it("merges a non-reserved header onto the request", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/x", { extraHeaders: { "X-Session-Id": "sess-1" } });
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Session-Id")).toBe("sess-1");
  });

  it("drops Authorization (any casing) — bearer token cannot be hijacked", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport({ apiKey: "nk_real" });
    await t.request("GET", "/x", {
      extraHeaders: { authorization: "Bearer nk_evil", AUTHORIZATION: "Bearer nk_evil2" },
    });
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer nk_real");
  });

  it("drops X-Noukai-API-Version (cannot downgrade version pin)", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/x", { extraHeaders: { "x-noukai-api-version": "1900-01-01" } });
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-noukai-api-version")).not.toBe("1900-01-01");
  });

  it("drops User-Agent and Cookie", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const t = makeTransport();
    await t.request("GET", "/x", {
      extraHeaders: { "User-Agent": "evil/1.0", Cookie: "session=stolen" },
    });
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).not.toBe("evil/1.0");
    expect(headers.get("Cookie")).toBeNull();
  });

  it("also applies to stream() — bearer cannot leak via SSE call", async () => {
    fetchSpy.mockResolvedValue(
      new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 }),
    );
    const t = makeTransport({ apiKey: "nk_real" });
    const it = t.stream("POST", "/stream", {
      extraHeaders: { Authorization: "Bearer nk_evil" },
    })[Symbol.asyncIterator]();
    await it.next();
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer nk_real");
  });
});
