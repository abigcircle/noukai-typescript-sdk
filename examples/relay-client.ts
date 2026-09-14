/**
 * Runnable example: drive a tool-calling flow through a relay, keyless.
 *
 * Design: 20260903-SDK-agent-relay (PR-2).
 *
 * `createRelayFlow` runs the SAME yield/resume loop as `flow.execute()` — but
 * over a keyless relay endpoint (no `nk_` key). This is the browser /
 * server-to-server / CLI agent entrypoint: your code drives the loop and
 * executes tools locally; a keyholder relay (see examples/relay-express.ts)
 * injects the key and forwards to the flow's `/execute`.
 *
 * In a browser, `url` is your own BFF route and `fetch` is the global fetch.
 * Run the relay server first (examples/relay-express.ts), then:
 *   npx tsx examples/relay-client.ts
 */

import { createRelayFlow } from "@noukai/sdk";

const RELAY_URL = "http://127.0.0.1:8000/agent/execute";

function myTools(toolCalls: Record<string, unknown>[]): Record<string, unknown>[] {
  // Execute the model's requested tool calls locally (stub).
  return toolCalls.map((call) => ({
    role: "tool",
    toolCallId: call.id,
    content: `tool-result-for-${String(call.id)}`,
  }));
}

async function main(): Promise<void> {
  // The relay's `authorize` hook (see examples/relay-express.ts) gates on an
  // `x-role: maker` header. `createRelayFlow` has no header hook, so attach it
  // by wrapping `fetch` — the standard way to add auth to a keyless relay client.
  const withRole: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-role", "maker");
    return fetch(input, { ...init, headers });
  };

  const flow = createRelayFlow({ url: RELAY_URL, fetch: withRole });

  // Structured chat/agent mode — the loop auto-resumes through the relay.
  const result = await flow.execute({
    messages: [{ role: "user", content: "make me a spelling pack" }],
    tools: [{ type: "function", function: { name: "lookup", description: "look something up" } }],
    toolChoice: "auto",
    toolHandler: myTools, // omit to get a PausedResult you drive with .resume()
  });

  if (result.requiresToolCalls) {
    throw new Error("unexpected pause");
  }
  console.log("status:", result.status);
  console.log("result:", result.result);
}

void main();
