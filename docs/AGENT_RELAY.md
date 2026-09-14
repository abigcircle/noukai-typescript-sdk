# Agent-over-relay — implementation guide (`@noukai/sdk`, TypeScript)

> **Audience: an LLM or developer implementing a relay.** This is a dense,
> self-contained spec. Read the [mental model](#1-mental-model-three-positions)
> first, decide [which position you are in](#2-which-position-am-i-in), then copy
> the matching recipe. Every code block is grounded in the shipped API — do not
> invent options that are not listed here.
>
> Design of record: `20260903-SDK-agent-relay` (see
> [`docs/design-logs/2026/09Sep/20260903-SDK-agent-relay.md`](./design-logs/2026/09Sep/20260903-SDK-agent-relay.md)).
> Python peer: [`noukai-sdk` `docs/AGENT_RELAY.md`](../../noukai-python-sdk/docs/AGENT_RELAY.md).

---

## 1. Mental model: three positions

A Noukai flow can pause mid-run to ask the caller to execute tools (the
**yield/resume tool-calling loop**). The `nk_` API key authorizes the flow. The
problem a relay solves: **the code that drives the loop and executes the tools is
often not the code that holds the key.** A browser must never see `nk_`.

The loop is written **once** and runs in three positions. The *only* thing that
changes between them is the **transport** — how each `/execute` round-trip is
sent.

```
  ┌───────────────────────────────────────────────────────────────┐
  │  Noukai server:  POST /seq/{org}/{project}/{slug}/execute      │
  │  yield/resume tool-calling; requires the `nk_` bearer          │
  └───────────▲───────────────────────────────▲──────────────────┘
   key-holding │ (DirectExecuteTransport)      │ key-holding, verbatim relay
              │                                │  (RelayExecuteTransport target)
  ┌───────────┴───────────┐        ┌───────────┴───────────────────────────┐
  │ POSITION 1: DIRECT     │        │ POSITION 2: SERVER RELAY (keyholder)   │
  │ flow.execute(...)      │        │ noukaiRelayHandler / createRelayRoute  │
  │ same process holds key,│        │ holds nk_, bounds abuse, authorize(),  │
  │ drives loop, runs tools│        │ forwards VERBATIM, relays status/body  │
  └────────────────────────┘        └───────────▲────────────────────────────┘
                                                 │ keyless POST (no nk_)
                                    ┌────────────┴───────────────────────────┐
                                    │ POSITION 3: KEYLESS CLIENT              │
                                    │ createRelayFlow({ url }).execute(...)   │
                                    │ browser / server-to-server / CLI:       │
                                    │ drives the SAME loop, runs tools locally│
                                    └────────────▲───────────────────────────┘
                                                 │ built on top of
                                    ┌────────────┴───────────────────────────┐
                                    │ POSITION 3b: REACT AGENT (@noukai/agent)│
                                    │ useAgentChat / runAgentLoop + registry  │
                                    └─────────────────────────────────────────┘
```

- **Position 1 — Direct.** Your key-holding server calls `flow.execute()`. No
  relay involved. This is the baseline; documented in the [main README](../README.md#tool-calls).
- **Position 2 — Server relay.** A keyholder proxy you mount on your own server.
  It is a thin, dumb, verbatim byte-pipe (with abuse bounds + an auth hook). This
  is what you build to let a browser drive a flow.
- **Position 3 — Keyless client.** Any code with **no** `nk_` key that drives the
  loop by POSTing to a relay URL: a browser, another server, a CLI agent.
- **Position 3b — React agent.** `@noukai/agent` wraps Position 3 with a tool
  registry and a React hook. It *depends on* `createRelayFlow` — same loop.

A complete browser feature is **Position 2 (your server) + Position 3/3b (the
browser)**. You almost always implement both halves.

---

## 2. Which position am I in?

| Your code… | holds `nk_`? | Position | Use |
|---|---|---|---|
| runs on your server, calls Noukai directly | ✅ yes | 1 — Direct | `flow.execute()` ([README](../README.md#tool-calls)) |
| runs on your server, exposes an endpoint a browser calls | ✅ yes | 2 — Server relay | `noukaiRelayHandler` / `createRelayRoute` — [§4](#4-position-2--serve-a-flow-server-relay) |
| runs in a browser / another server / a CLI, no key | ❌ no | 3 — Keyless client | `createRelayFlow` — [§5](#5-position-3--drive-a-flow-keyless-client) |
| a React component | ❌ no | 3b — React agent | `useAgentChat` from `@noukai/agent` — [§6](#6-position-3b--react-agent-noukaiagent) |

---

## 3. The wire contract (authoritative)

Every position speaks this one contract. The relay forwards it **verbatim**; the
loop produces/consumes it. Source: `SeqflowExecuteRequest` /
`SeqflowExecuteResponse` / `SeqflowExecutePausedResponse` in the router-ai-slugs
service. **Wire field names are `camelCase`** (except inside `messages[]` /
`toolCallMessages[]`, which are OpenAI-style `snake_case`).

### 3.1 Fresh call — two modes

**Structured / chat / agent mode** (Pack Maker style — preferred for agents):

```jsonc
POST <relay-url>            // relay forwards to /seq/{org}/{project}/{slug}/execute
{
  "messages": [ { "role": "user", "content": "make me a spelling pack" } ],
  "tools": [ /* OpenAI-style ToolDef */ ],
  "toolChoice": "auto"      // "auto" | "none" | "required" | { … }
}
```

- `messages[]` roles are **restricted to `user` | `assistant` | `tool`**. A
  `system` or `function` turn → **400 `MESSAGES_ROLE_INVALID`** (it would
  override the flow author's system prompt). The SDK also rejects these
  client-side before the request leaves.
- The **last entry is the current user turn.** History is fed to the model as
  real role turns (not flattened).

**Single-message mode** (Nana style):

```jsonc
{ "message": "hi", "tools": [ … ], "parameters": { "conversation": [ … ] } }
```

Provide **exactly one** of `message` / `messages` on a fresh call. The SDK
enforces this client-side (`validateFreshCall`).

### 3.2 Yield (HTTP 200) — the flow paused for tools

```jsonc
{
  "status": "tool_calls_required",
  "executionId": "…",
  "pausedAtStep": "…",
  "iterationsUsed": 1,
  "toolCallMessages": [ … ],       // opaque prior-turn state; pass back on resume
  "toolCalls": [ { "id": "call_1", "type": "function",
                   "function": { "name": "lookup", "arguments": "{…}" } } ],
  "accumulatedOutputs": { … },
  "flowId": "…",
  "blockCount": 3
}
```

### 3.3 Resume — send tool results, continue

```jsonc
{
  "executionId": "…",              // required
  "pausedAtStep": "…",             // required   } all three identify the resume
  "toolCallMessages": [ …prev, …toolResults ],  // required
  "iterationsUsed": 1,
  "accumulatedOutputs": { … },
  "tools": [ … ]
}
```

A **tool result** entry uses the camelCase Noukai wire:

```jsonc
{ "role": "tool", "toolCallId": "call_1", "content": "72°F and sunny" }
```

### 3.4 Complete (HTTP 200) — final result

```jsonc
{ "status": "completed", "result": { … }, "flowId": "…", "blockCount": 3 }
```

> **You rarely hand-build any of this.** The loop (`createRelayFlow`, or
> `flow.execute`) builds fresh/resume payloads and parses yield/complete for you.
> Hand-build only if you are writing a *new* keyless client from scratch in a
> language without an SDK. The relay itself **never parses** these beyond bounds
> checks — it is a byte-pipe.

### 3.5 Errors / status codes

| Status | `detail` / code | Origin | Meaning |
|---|---|---|---|
| 400 | `INVALID_JSON` | **relay** | body was not a JSON object |
| 400 | `MESSAGES_ROLE_INVALID` | server | a `system`/`function` role in `messages[]` |
| 403 | `FORBIDDEN` (or your `detail`) | **relay** | `authorize` hook rejected |
| 413 | `BODY_TOO_LARGE` | **relay** | raw bytes > `maxBodyBytes` (before parse) |
| 413 | `TOO_MANY_MESSAGES` | **relay** | `messages[]`/`toolCallMessages[]` length > `maxMessages` |
| 413 | `MESSAGES_TOO_LARGE` | server | payload > 1 MB |
| 4xx | `TOOLS_NOT_ENABLED`, `TOOL_ITERATION_LIMIT`, `TOOLS_REQUIRE_SYNC_EXECUTE` | server | tool-config errors |
| 502 | `UPSTREAM_UNAVAILABLE` | **relay** | connection/timeout to Noukai (no upstream status to relay) |
| *upstream* | `UPSTREAM_NON_JSON` | **relay** | upstream returned a non-JSON body; relayed at the upstream status |

The relay passes every **server** status/body through unchanged. It only
*originates* the rows marked **relay**.

---

## 4. Position 2 — serve a flow (server relay)

Your key-holding server exposes a keyless endpoint. The relay: reads the raw body
→ bounds it (bytes **before** parse, then message counts) → `await authorize(req)`
→ forwards verbatim to `/seq/{org}/{project}/{slug}/execute` with the `nk_`
bearer (`raiseForStatus: false`) → relays the upstream `(status, body)`.

The flow is **pinned** to one `org/project/slug` — a caller cannot redirect the
relay to another flow.

### 4.1 Express

```typescript
import express from "express";
import { Noukai } from "@noukai/sdk";
import { noukaiRelayHandler } from "@noukai/sdk/adapters/express";

const noukai = new Noukai({ apiKey: process.env.NOUKAI_API_KEY }); // holds nk_ server-side
const app = express();

// IMPORTANT: do NOT mount a JSON body parser on the relay route — the handler
// reads the raw body itself so it can cap bytes before parsing.
app.post(
  "/agent/execute",
  noukaiRelayHandler({
    client: noukai,
    org: "acme",
    project: "spelling",
    slug: "pack-maker",
    // App authorization — throw to reject. NEVER bake this into the SDK.
    // An error carrying a numeric `status`/`statusCode` sets the HTTP status;
    // anything else → 403 FORBIDDEN (the thrown message is never echoed).
    authorize: (req) => {
      if (req.headers["x-role"] !== "maker") {
        throw Object.assign(new Error("maker role required"), { status: 403, detail: "MAKER_REQUIRED" });
      }
    },
    bounds: { maxBodyBytes: 262_144, maxMessages: 40 }, // defaults if omitted
  }),
);

app.listen(8000);
```

### 4.2 Next.js App Router

```typescript
// app/agent/execute/route.ts
import { Noukai } from "@noukai/sdk";
import { createRelayRoute } from "@noukai/sdk/adapters/nextjs";

const noukai = new Noukai({ apiKey: process.env.NOUKAI_API_KEY });

export const POST = createRelayRoute({
  client: noukai,
  org: "acme",
  project: "spelling",
  slug: "pack-maker",
  authorize: async (req) => {              // req is a Web `Request`
    if (req.headers.get("x-role") !== "maker") {
      throw Object.assign(new Error("maker role required"), { status: 403 });
    }
  },
  bounds: { maxBodyBytes: 262_144, maxMessages: 40 },
});
```

### 4.3 Options — `noukaiRelayHandler` / `createRelayRoute`

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `Noukai` | — | **required.** Holds the `nk_` bearer injected on the forward. |
| `org`, `project`, `slug` | `string` | — | **required.** The single flow this relay is pinned to. |
| `authorize` | `(req) => void \| Promise<void>` | — | **required.** `req` is the Express request / Web `Request`. Throw to reject. |
| `bounds.maxBodyBytes` | `number` | `262144` (256 KiB) | Raw-byte cap, enforced *before* JSON parse and mid-read (never fully buffered). |
| `bounds.maxMessages` | `number` | `40` | Caps each of `messages[]` / `toolCallMessages[]` independently. |
| `version` | `"draft" \| number` | `"draft"` | Draft, or a published integer version. |

Exported constants: `DEFAULT_RELAY_PATH` (`"/agent/execute"`),
`DEFAULT_MAX_BODY_BYTES`, `DEFAULT_MAX_MESSAGES` from `@noukai/sdk/adapters/express`
(and `/nextjs`).

### 4.4 Security invariants — non-negotiable

1. **App authorization lives in `authorize`, never in the SDK.** Role checks,
   session/JWT validation, rate-limit gates → all in the hook.
2. **Bounds are adapter config, never SDK-wide constants.** Tune `maxBodyBytes` /
   `maxMessages` per deployment.
3. **The relay never logs the key or the body.** Do **not** enable `logPayloads`
   on the relay's `Noukai` client — that would route the forwarded browser
   payload and upstream body to your log handler. (The `nk_` key is never logged
   regardless.)
4. **Verbatim passthrough.** The relay does not interpret business payloads and
   does not raise typed errors in place of relaying status (it forwards with
   `raiseForStatus: false`). For **strictly** verbatim status passthrough,
   construct the relay's client with `maxRetries: 0` — otherwise the transport
   retries a retryable upstream 5xx before relaying it.
5. **The flow is pinned.** `org/project/slug` are fixed at mount; a caller can
   never point the relay at a different flow.

### 4.5 Common mistakes

- ❌ Mounting `express.json()` on the relay route → the byte cap can't run on raw
  bytes. Leave the route parser-free.
- ❌ Echoing the thrown error's `.message` to reject — the SDK deliberately
  drops it (it may hold internal detail). Set an explicit `detail` on the thrown
  error to customize client-facing text.
- ❌ Putting the maker-role / auth logic anywhere but `authorize`.

Runnable: [`examples/relay-express.ts`](../examples/relay-express.ts).

---

## 5. Position 3 — drive a flow (keyless client)

Code with **no** `nk_` key drives the same loop by POSTing to a relay URL.
`createRelayFlow({ url })` returns a `RelayFlow` whose `.execute()` runs the
identical yield/resume loop as `flow.execute()` — same round limit (`10`), same
`PausedResult` — over a keyless `RelayExecuteTransport`.

```typescript
import { createRelayFlow } from "@noukai/sdk";

// In a browser, `url` is your own relay/BFF route and fetch is global.
const flow = createRelayFlow({ url: "/agent/execute" }); // pass fetch? for a custom runtime

// Auto-resume: give a toolHandler and the loop runs to completion.
const result = await flow.execute({
  messages: [{ role: "user", content: "make me a spelling pack" }],
  tools: [{ type: "function", function: { name: "lookup", description: "look up a word" } }],
  toolChoice: "auto",
  toolHandler: (toolCalls) =>
    toolCalls.map((call) => ({
      role: "tool",
      toolCallId: call.id,
      content: `result-for-${String(call.id)}`,
    })),
});

if (!result.requiresToolCalls) {
  console.log(result.status, result.result);
}
```

### 5.1 `RelayFlow.execute()` options

| Option | Type | Notes |
|---|---|---|
| `message` | `string` | Single-message mode. Mutually exclusive with `messages`. |
| `messages` | `ChatMessage[]` | Structured mode. Roles `user\|assistant\|tool` only. |
| `tools` | `Record<string, unknown>[]` | OpenAI-style tool defs. |
| `toolChoice` | `"auto" \| "none" \| "required" \| object` | |
| `toolHandler` | `(toolCalls) => toolResults \| Promise<…>` | Omit → returns a `PausedResult` to drive manually. |
| `maxToolRounds` | `number` | Default `10`; exceeding throws `ToolCallLimitError`. |
| `parameters` | `Record<string, unknown>` | Passed through (e.g. `{ conversation }` in single-message mode). |
| `trace` | `boolean` | Default `false`. |
| `signal` | `AbortSignal` | Cancels in-flight rounds. |

`createRelayFlow({ url, fetch? })` — `fetch` defaults to global `fetch`; pass a
custom one for a non-standard runtime or tests.

### 5.2 Manual resume (no `toolHandler`)

```typescript
let result = await flow.execute({ messages: [{ role: "user", content: "…" }], tools });
while (result.requiresToolCalls) {
  const toolResults = await runTools(result.toolCalls);
  result = await result.resume({ toolResults });
}
console.log(result.result);
```

`result.requiresToolCalls` narrows the union: `true` → `PausedResult` (has
`.toolCalls`, `.resume(...)`); `false` → `ExecuteResult` (has `.result`).

Runnable: [`examples/relay-client.ts`](../examples/relay-client.ts).

---

## 6. Position 3b — React agent (`@noukai/agent`)

`@noukai/agent` is a **separate package** that depends on `@noukai/sdk`. It wraps
Position 3 with a declarative tool registry, progress labels, and a React hook.
Its loop *is* `createRelayFlow` — nothing new on the wire.

```tsx
import { useAgentChat, createToolRegistry } from "@noukai/agent";

// 1. Register tools — resolved locally, in the browser.
const registry = createToolRegistry();
registry.register({
  definition: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
  resolve: (args) => `72°F and sunny in ${args.city}`,
});

// 2. Drive the loop from a component. `endpoint` is your Position-2 relay route.
function ChatPanel() {
  const { messages, isLoading, sendMessage } = useAgentChat({
    endpoint: "/agent/execute",          // ← your relay from §4
    tools: registry.definitions(),
    resolveToolCall: (call) => registry.resolve(call),
    // sendStructuredMessages: true,     // opt into structured `messages` mode
  });
  return (
    <div>
      {messages.map((m) => <div key={m.id} data-role={m.role}>{m.content}</div>)}
      <input disabled={isLoading} onKeyDown={(e) => {
        if (e.key === "Enter") { sendMessage(e.currentTarget.value); e.currentTarget.value = ""; }
      }} />
    </div>
  );
}
```

Pure loop (no React) for server actions / CLIs / tests:

```ts
import { runAgentLoop } from "@noukai/agent";

const result = await runAgentLoop("Hello", {
  endpoint: "/agent/execute",
  tools: registry.definitions(),
  resolveToolCall: (call) => registry.resolve(call),
  maxIterations: 5,
  signal: controller.signal, // optional
});
if (result.type === "message") console.log(result.content);
```

Full framework reference (registry, label formatter, two request modes, the
endpoint contract): [`@noukai/agent` README](../../noukai-typescript-agent-sdk/README.md).

> **Aspirational, do not use:** `protocol.ts` (opaque `stateToken`) and
> `session-store.ts` in `@noukai/agent` have no importers. The `stateToken`
> hardening (so the browser stops seeing raw `executionId`/`toolCallMessages`
> execution-state) is a **future** backend-coordinated change (design F5). Until
> then, relays echo server execution-state — acceptable **behind auth + bounds**.

---

## 7. End-to-end recipe (browser feature)

1. **Server (Position 2):** mount `noukaiRelayHandler` / `createRelayRoute` at
   `POST /agent/execute`, pinned to your flow, with an `authorize` hook and
   `bounds`. Client built with `logPayloads` off; `maxRetries: 0` if you need
   strict status passthrough.
2. **Browser (Position 3 or 3b):** either `createRelayFlow({ url: "/agent/execute" })`
   for a plain loop, or `useAgentChat({ endpoint: "/agent/execute", … })` for
   React. Register tools; resolve them locally.
3. **Never** ship the `nk_` key to the browser. The browser POSTs keyless; the
   relay injects the key.

---

## 8. Implementation checklist (verify before shipping)

- [ ] Relay route has **no** JSON body parser mounted.
- [ ] `authorize` implements the real check (session/JWT/role), throws to reject,
      and sets an explicit `detail` for any client-facing text.
- [ ] `bounds` tuned for the deployment; defaults are 256 KiB / 40.
- [ ] Relay's `Noukai` client has `logPayloads` **off**.
- [ ] Flow is pinned (`org/project/slug` fixed); caller cannot redirect it.
- [ ] Browser code holds **no** `nk_` key and points at the relay URL.
- [ ] Tool results returned as `{ role: "tool", toolCallId, content }`.
- [ ] `messages[]` uses only `user`/`assistant`/`tool` roles.
- [ ] Round limit understood (`10`; `ToolCallLimitError` on overflow).
- [ ] Error/status table (§3.5) handled on the browser side.
```
