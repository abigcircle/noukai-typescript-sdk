/**
 * messages support (F6) + keyless relay flow (design 20260903-SDK-agent-relay, PR-2).
 *
 * flow.execute({messages}) tests use the global fetch spy; RelayFlow tests
 * inject a custom `fetch` into `createRelayFlow` (deterministic, no global spy).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Noukai, createRelayFlow, ToolCallLimitError, InsufficientCreditsError } from "../src/index.js";
import type { ChatMessage } from "../src/index.js";

const COMPLETED = { status: "completed", result: { ok: true }, flowId: "f", blockCount: 1 };
function paused() {
  return {
    status: "tool_calls_required",
    executionId: "exec-1",
    pausedAtStep: "s1",
    iterationsUsed: 1,
    toolCallMessages: [{ role: "assistant", content: "call" }],
    toolCalls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }],
    accumulatedOutputs: {},
    flowId: "f",
    blockCount: 1,
  };
}

// A custom fetch that returns a scripted sequence of (status, body) and records calls.
function scriptedFetch(seq: { status: number; body: unknown }[]): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let n = 0;
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = seq[Math.min(n, seq.length - 1)]!;
    n++;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Extract a request body as a JSON string (bodies here are always JSON strings). */
function bodyText(init: RequestInit | undefined): string {
  return (init?.body ?? "") as string;
}

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => {
  fetchSpy.mockReset();
  // Default impl so the spy is never left implementation-less (an unmocked
  // global fetch spy surfaces a spurious "Failed to parse URL" in this harness).
  // The RelayFlow tests inject their own fetch and never hit this.
  fetchSpy.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
});

// ---------------------------------------------------------------------------
// flow.execute({ messages })
// ---------------------------------------------------------------------------

describe("flow.execute messages", () => {
  it("sends `messages` on the wire (not `message`)", async () => {
    let body: Record<string, unknown> = {};
    fetchSpy.mockImplementation((_url, init) => {
      body = JSON.parse(bodyText(init)) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify(COMPLETED), { status: 200 }));
    });
    const noukai = new Noukai({ apiKey: "nk_test" });
    const result = await noukai
      .flow("a/b/c")
      .execute({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(result.status).toBe("completed");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.message).toBeUndefined();
  });

  it("rejects both message and messages", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED), { status: 200 }));
    const noukai = new Noukai({ apiKey: "nk_test" });
    await expect(
      noukai.flow("a/b/c").execute({ message: "hi", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/not both/);
  });

  it.each(["system", "function", "developer"])("rejects role %s", async (role) => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(COMPLETED), { status: 200 }));
    const noukai = new Noukai({ apiKey: "nk_test" });
    await expect(
      noukai.flow("a/b/c").execute({ messages: [{ role, content: "x" }] }),
    ).rejects.toThrow(/not allowed/);
  });
});

// ---------------------------------------------------------------------------
// createRelayFlow / RelayFlow — keyless loop over the relay transport
// ---------------------------------------------------------------------------

const RELAY_URL = "https://bff.example.com/agent/execute";

describe("createRelayFlow", () => {
  it("POSTs the payload to the relay URL keyless and relays completed", async () => {
    const { fetch: f, calls } = scriptedFetch([{ status: 200, body: COMPLETED }]);
    const flow = createRelayFlow({ url: RELAY_URL, fetch: f });
    const result = await flow.execute({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(result.status).toBe("completed");
    // Keyless: no Authorization header, posted to the relay URL.
    expect(calls[0]!.url).toBe(RELAY_URL);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    const sentBody = JSON.parse(bodyText(calls[0]!.init)) as Record<string, unknown>;
    expect(sentBody.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("returns a PausedResult that resumes over the relay", async () => {
    const { fetch: f } = scriptedFetch([
      { status: 200, body: paused() },
      { status: 200, body: COMPLETED },
    ]);
    const flow = createRelayFlow({ url: RELAY_URL, fetch: f });
    const p = await flow.execute({ message: "hi", tools: [] });
    expect(p.requiresToolCalls).toBe(true);
    if (!p.requiresToolCalls) throw new Error("expected paused");
    const final = await p.resume({
      toolResults: [{ role: "tool", toolCallId: "tc1", content: "r" }],
    });
    expect(final.status).toBe("completed");
  });

  it("auto-loops with a toolHandler (sync + async)", async () => {
    for (const handler of [
      (calls: Record<string, unknown>[]) =>
        calls.map((c) => ({ role: "tool", toolCallId: c.id, content: "r" })),
      async (calls: Record<string, unknown>[]) =>
        Promise.resolve(calls.map((c) => ({ role: "tool", toolCallId: c.id, content: "r" }))),
    ]) {
      const { fetch: f } = scriptedFetch([
        { status: 200, body: paused() },
        { status: 200, body: COMPLETED },
      ]);
      const flow = createRelayFlow({ url: RELAY_URL, fetch: f });
      const result = await flow.execute({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolHandler: handler,
      });
      expect(result.status).toBe("completed");
    }
  });

  it("trips the shared round limit (10) when the flow never terminates", async () => {
    const { fetch: f } = scriptedFetch([{ status: 200, body: paused() }]); // always paused
    const flow = createRelayFlow({ url: RELAY_URL, fetch: f });
    await expect(
      flow.execute({
        message: "hi",
        tools: [],
        toolHandler: (calls) => calls.map((c) => ({ role: "tool", toolCallId: c.id, content: "r" })),
      }),
    ).rejects.toBeInstanceOf(ToolCallLimitError);
  });

  it("maps an upstream non-2xx to a typed error", async () => {
    const { fetch: f } = scriptedFetch([
      { status: 402, body: { detail: { code: "INSUFFICIENT_CREDITS", message: "broke" } } },
    ]);
    const flow = createRelayFlow({ url: RELAY_URL, fetch: f });
    await expect(flow.execute({ message: "hi" })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("rejects both message and messages", async () => {
    const { fetch: f } = scriptedFetch([{ status: 200, body: COMPLETED }]);
    const flow = createRelayFlow({ url: RELAY_URL, fetch: f });
    await expect(
      flow.execute({ message: "hi", messages: [{ role: "user", content: "hi" }] as ChatMessage[] }),
    ).rejects.toThrow(/not both/);
  });
});
