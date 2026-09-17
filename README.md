# @noukai/sdk

TypeScript SDK for executing [Noukai](https://noukai.dev) flows.

Universal runtime — works in Node 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge. ESM-only, fully typed, zero runtime dependencies.

- [Install](#install)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Client configuration](#client-configuration)
- [Executing flows](#executing-flows)
- [Streaming steps and events](#streaming-steps-and-events)
- [Async (queue-backed) jobs](#async-queue-backed-jobs)
- [Tool calls](#tool-calls)
- [Replay & session grouping](#replay--session-grouping-experimental)
- [Flow versions](#flow-versions)
- [Run traces](#run-traces)
- [Errors](#errors)
- [Timeouts, retries, cancellation](#timeouts-retries-cancellation)
- [Logging](#logging)
- [Resource management](#resource-management)

## Install

```bash
pnpm add @noukai/sdk
# or
npm install @noukai/sdk
# or
yarn add @noukai/sdk
```

Requires Node 18+ (or an equivalent modern runtime with `fetch`, `ReadableStream`, and `AbortController`).

## Quick start

```typescript
import { Noukai } from "@noukai/sdk";

await using noukai = new Noukai();        // reads NOUKAI_API_KEY env var

const result = await noukai
  .flow("acme/spelling/grade-3")
  .execute({ message: "The cat sat on the mat." });

console.log(result.result);
```

The `await using` syntax (TC39 explicit resource management, available in Node 20+ and TypeScript 5.2+) automatically releases the underlying HTTP pool at the end of the block. If your runtime doesn't support it, call `await noukai.close()` manually.

## Authentication

API keys start with `nk_`. Provide one of:

1. **`NOUKAI_API_KEY` environment variable** — recommended.
2. **`apiKey` constructor option** — overrides the env var.

```typescript
const noukai = new Noukai({ apiKey: "nk_..." });
```

If no key is found, the constructor throws `AuthenticationError` immediately.

> **Never use this SDK in the browser.** API keys grant full access to your organization's flows and credits. The SDK logs a console warning when `window` is detected. Use a server runtime (Node, Bun, Workers, Edge) and proxy from your frontend.

## Client configuration

```typescript
const noukai = new Noukai({
  apiKey: "nk_...",          // overrides NOUKAI_API_KEY
  env: "production",         // or "dev" — default "production"
  org: "acme",               // default org for short-form slugs
  project: "spelling",       // default project for short-form slugs
  timeout: 300_000,          // default per-request timeout (ms)
  maxRetries: 1,             // retries on retryable 5xx
  onLog: (event) => { ... }, // structured logging hook
  logPayloads: false,        // include request/response bodies in logs
  signal: abortController.signal, // cancels every in-flight request
});
```

### `env` shortcut

| Value          | Base URL                                  |
| -------------- | ----------------------------------------- |
| `"production"` (default) | `https://api.noukai.dev/api/v1` |
| `"dev"`        | `http://localhost:8080/api/v1`            |

Falls back to the `NOUKAI_ENV` env var. The SDK does **not** accept an arbitrary base URL — all requests target Noukai's hosted endpoints.

### Default `org` / `project`

When you set both, you can address flows by their short slug:

```typescript
const noukai = new Noukai({ org: "acme", project: "spelling" });

noukai.flow("grade-3");                // → acme/spelling/grade-3
noukai.flow("other-org/x/grade-3");    // fully qualified — wins
```

`org` and `project` must be passed together (or not at all). Half-defaults throw.

## Executing flows

### Three identifier forms

```typescript
noukai.flow("grade-3");                // single segment — needs client defaults
noukai.flow("acme/spelling/grade-3");  // fully qualified
noukai.flow({ org: "acme", project: "spelling", slug: "grade-3" });
```

### `execute()` — synchronous, in-process

Blocks until the flow completes (or pauses for tools).

```typescript
const result = await noukai.flow("acme/spelling/grade-3").execute({
  message: "Input text",
  parameters: { difficulty: "hard" },        // extra initial inputs
  blockOverrides: { "step-id": { temperature: 0.5 } },
  attachments: [{ url: "https://...", mimeType: "image/png" }],
  trace: false,                              // capture full I/O for trace
  version: "draft",                          // or a published integer
  timeout: 60_000,                           // override client default
  signal: controller.signal,                 // cancel this call only
});

if (result.requiresToolCalls) {
  // PausedResult — see "Tool calls" below
} else {
  console.log(result.result);                // ExecuteResult
}
```

Return type is `ExecuteResult | PausedResult`. The `requiresToolCalls` discriminator narrows the union:

```typescript
if (result.requiresToolCalls === false) {
  // TypeScript now knows result is ExecuteResult
}
```

## Streaming steps and events

For long-running flows, stream output as it arrives. Both methods return `AsyncIterable`, so they work with `for await` and respect `break`/`return` for early termination.

### `steps()` — one event per finished step

```typescript
const flow = noukai.flow("acme/spelling/grade-3");

for await (const step of flow.steps({ message: "..." })) {
  console.log(step.name, step.output, step.durationMs, step.tokens);
}
```

Yields `StepCompleted` events only. Intermediate signals (`step_started`, `step_input`, `flow_completed`) are filtered out.

### `events()` — every typed SSE event

```typescript
for await (const event of flow.events({ message: "..." })) {
  switch (event.type) {
    case "run_started":          // RunStarted
    case "step_started":         // StepStarted
    case "step_input":           // StepInput
    case "step_output":          // StepOutput
    case "step_completed":       // StepCompleted
    case "step_error":           // StepFailed
    case "step_paused":          // StepPaused
    case "tool_calls_required":  // ToolCallsRequired (has .resume())
    case "flow_completed":       // FlowCompleted
  }
}
```

Pass `runRemaining: true` to have the server stream every remaining step in a single SSE connection instead of pausing between steps.

## Async (queue-backed) jobs

For long executions where you don't want to hold an HTTP connection open, submit to the server's job queue and poll for the result.

```typescript
const job = await noukai.flow("acme/spelling/grade-3").executeAsync({
  message: "Long input that takes minutes...",
  trace: true,
});

console.log(job.executionId);  // persist this if you want to resume later

// Block until done — polls under the hood (default: 2s interval, 5min timeout).
const status = await job.wait({ timeout: 600_000, pollInterval: 5_000 });
console.log(status.result);

// Or one-shot:
const snapshot = await job.poll();
if (snapshot.status === "completed") { ... }
```

Tool calls are **not** supported on this path (server-side limitation).

## Tool calls

Flows can pause to request tool execution from your code. The SDK has two modes.

### Auto-resume (recommended)

Pass `toolHandler`; the SDK runs your handler against each pending call and resumes automatically until the flow finishes or `maxToolRounds` is hit.

```typescript
const result = await flow.execute({
  message: "What's the weather in Paris?",
  tools: [
    { type: "function", function: { name: "get_weather", parameters: {...} } },
  ],
  toolHandler: async (toolCalls) => {
    return toolCalls.map((call) => ({
      toolCallId: call.id,
      output: JSON.stringify(getWeather(call.function.arguments)),
    }));
  },
  maxToolRounds: 10,  // default — raises ToolCallLimitError if exceeded
});
```

### Manual resume

Omit `toolHandler` and drive the loop yourself:

```typescript
let result = await flow.execute({ message: "...", tools: [...] });

while (result.requiresToolCalls) {
  const toolResults = await runTools(result.toolCalls);
  result = await result.resume({ toolResults });
}

console.log(result.result);
```

During streaming, `ToolCallsRequired` events expose the same `.resume({ toolResults })` method.

### Structured `messages` (chat / agent flows)

`execute()` accepts a structured `messages` list — mutually exclusive with `message` — for chat and agent flows. The last entry is the current user turn:

```typescript
const result = await flow.execute({
  messages: [{ role: "user", content: "Draft a spelling pack for grade 3" }],
  tools: [...],
  toolChoice: "auto",
});
```

Roles must be `user`, `assistant`, or `tool` — a `system`/`function` turn is rejected client-side (it would override the flow author's system prompt). The SDK also warns as a `messages` payload approaches the server's 1 MB cap.

### Driving the loop through a relay

When your code holds **no** `nk_` key — a browser, or a server-to-server / CLI agent talking to a keyholder relay — point the **same** tool-calling loop at the relay endpoint with `createRelayFlow`. Each round is POSTed to the relay keyless; the relay injects the key and forwards to the flow:

```typescript
import { createRelayFlow } from "@noukai/sdk";

const flow = createRelayFlow({ url: "/agent/execute" }); // pass fetch? for a custom runtime
const result = await flow.execute({
  messages: [{ role: "user", content: "..." }],
  tools: [...],
  toolHandler: myTools, // identical handler API to flow.execute()
});
```

The loop, the client round limit (`10`), and the `PausedResult` you get back are identical to `flow.execute()` — only the transport differs (keyless relay vs the key-holding direct transport). A full runnable example is in [`examples/relay-client.ts`](examples/relay-client.ts).

Pass `timeout` (seconds) to bound each relay round-trip so a hung relay can't stall the loop forever — `createRelayFlow({ url, timeout: 30 })`. It defaults to the SDK's `300` s and combines with any per-call `signal` (either aborts the request).

## Serving a flow to a browser (relay)

A **relay** lets a browser (or any keyless client) drive a tool-calling flow
without ever seeing your `nk_` key. Your server holds the key and mounts a thin
relay endpoint: it bounds abuse, runs your own authorization hook, then forwards
the request **verbatim** to the flow's `/execute` endpoint and relays the
upstream response back unchanged. The browser drives the loop and executes tools;
your server is a keyholder proxy.

The relay never interprets the business payload, never logs the key or body, and
passes upstream 4xx/5xx through verbatim (built on the transport's
`raiseForStatus: false` mode).

```typescript
import express from "express";
import { Noukai } from "@noukai/sdk";
import { noukaiRelayHandler } from "@noukai/sdk/adapters/express";

const noukai = new Noukai({ apiKey: "nk_..." }); // holds the key server-side
const app = express();

app.post(
  "/agent/execute",
  noukaiRelayHandler({
    client: noukai,
    org: "acme",
    project: "spelling",
    slug: "pack-maker",
    // Your app's authorization — throw to reject. Never baked into the SDK.
    authorize: (req) => {
      if (req.headers["x-role"] !== "maker") {
        throw Object.assign(new Error("maker role required"), { status: 403 });
      }
    },
    bounds: { maxBodyBytes: 262_144, maxMessages: 40 },
  }),
);
```

Mount the relay route **without** a JSON body parser so it can bound the raw
bytes before parse. The browser POSTs `{ messages, tools, toolChoice }` (or a
resume payload) with no key and receives the flow's response verbatim. Bounds
violations return `413 { detail: "BODY_TOO_LARGE" }` / `413 { detail:
"TOO_MANY_MESSAGES" }`; malformed JSON returns `400 { detail: "INVALID_JSON" }`;
a non-JSON upstream returns `{ detail: "UPSTREAM_NON_JSON" }` at the upstream
status.

Next.js App Router gets the Route Handler equivalent:

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
  authorize: async (req) => {
    if (req.headers.get("x-role") !== "maker") {
      throw Object.assign(new Error("maker role required"), { status: 403 });
    }
  },
  bounds: { maxBodyBytes: 262_144, maxMessages: 40 },
});
```

The TS `authorize` hook signals rejection by **throwing**: an error optionally
carrying a numeric `status` or `statusCode` sets the response status (the thrown
error's message is never echoed to the client — it defaults to `403`). This
differs from the Python peer, where `authorize` raises the framework's
`HTTPException` directly.

A full runnable example lives in [`examples/relay-express.ts`](examples/relay-express.ts).
For the complete relay spec — the three positions (serve / keyless client /
React agent), the authoritative wire contract, the error table, and an
implementation checklist — see [`docs/AGENT_RELAY.md`](docs/AGENT_RELAY.md).

> **Notes.** The relay reads the raw body with a hard byte cap (streamed, so an
> oversized body is rejected mid-read — it is never fully buffered). Do **not**
> enable `logPayloads` on a relay client: the forwarded browser payload and the
> upstream body would then reach your log handler (the `nk_` key is never logged
> regardless). On a connection/timeout to the upstream the relay returns
> `502 { detail: "UPSTREAM_UNAVAILABLE" }`. For strictly verbatim status
> passthrough, construct the relay's client with `maxRetries: 0` — the TS
> transport otherwise retries a retryable upstream 5xx before relaying it.

## Replay & session grouping (experimental)

`replayScope` groups every Noukai call in its body under one session id, so you
can later replay the recorded behavior without re-hitting LLM providers.

### Capture

#### Express

```typescript
import express from "express";
import { Noukai } from "@noukai/sdk";
import { noukaiTraceMiddleware } from "@noukai/sdk/adapters/express";

const app = express();
const noukai = new Noukai({ apiKey: "nk_...", org: "acme", project: "spelling" });

app.use(noukaiTraceMiddleware({ client: noukai }));

app.post("/grade", async (req, res) => {
  const result = await noukai.flow("grade-3").execute({ message: req.body.text });
  res.json({ out: result.result, session_id: result.sessionId });
  // Response also carries X-Noukai-Session header automatically.
});
```

#### Next.js App Router

```typescript
import { Noukai } from "@noukai/sdk";
import { withNoukaiTrace } from "@noukai/sdk/adapters/nextjs";

const noukai = new Noukai({ apiKey: "nk_...", org: "acme", project: "spelling" });

export const POST = withNoukaiTrace(async (req) => {
  const body = await req.json() as { text: string };
  const result = await noukai.flow("grade-3").execute({ message: body.text });
  return Response.json({ out: result.result });
  // Response also carries X-Noukai-Session header automatically.
}, { client: noukai });
```

### Replay (debugging against your own API)

The goal of replay is debuggability — re-running a recorded execution through
your live API code without hitting any LLMs. Useful for stepping a debugger
through a failed production request, or re-running a known scenario after
editing your handler.

**End-to-end flow:**

1. **Capture the session id during normal traffic.** Capture runs automatically
   whenever a request enters a route wired through `noukaiTraceMiddleware`
   (Express) or `withNoukaiTrace` (Next.js). The adapter sets
   `X-Noukai-Session: <session_id>` on the response — log it or surface it
   through your error reporter so you have the handle to replay later.

2. **Start your API in dev with the replay gate on:**

   ```bash
   NOUKAI_REPLAY_ENABLED=true node server.js
   # or `next dev`, `tsx server.ts`, etc. — whatever you normally use
   ```

3. **Call your own API the same way a real client would**, just add the replay
   header pointing at the captured session id. Replace the URL below with
   *your* app's dev URL and the route you wrote in step 1 (here `/grade` on
   the default Express port):

   ```bash
   curl -H 'X-Noukai-Replay: abc-123' \
        -H 'Content-Type: application/json' \
        -d '{"text":"anything — the body is not matched against the cassette"}' \
        http://localhost:3000/grade
   ```

   The adapter middleware detects the header, fetches the recorded session via
   `GET /seq/sessions/{id}` (idempotent, retried by the transport), and serves
   every `flow.execute()` / `steps()` / `events()` call inside the route from
   the cassette. No LLM calls, no charges, deterministic output.

Your handler code runs for real — only the Noukai SDK calls are served from
the cassette. That means you can edit the handler between replays and the
same session id keeps working, as long as your code still makes the same
sequence of Noukai calls. This is the fast path for verifying a bug fix or
iterating on post-processing logic.

> **Non-HTTP contexts.** For workers, CLI tools, tests, or scripts where there
> is no inbound request to carry the header, open the scope programmatically:
> ```typescript
> import { replayScope } from "@noukai/sdk";
>
> await replayScope(
>   async () => {
>     const result = await noukai.flow("grade-3").execute({ message: "any input" });
>     console.log(result.result);   // served from cassette
>   },
>   { replaySessionId: "abc-123", transport: noukai._transport },
> );
> ```
> The same `NOUKAI_REPLAY_ENABLED` gate applies.

### Capture vs replay

| Scenario | Behavior |
|---|---|
| No `replayScope`, no `X-Noukai-Replay` | Normal live call, no session tagging. |
| Inside `replayScope` (no replay header) | Capture mode — fresh `sessionId` generated, tagged on outbound `X-Session-Id`. |
| `X-Noukai-Replay` header present, `NOUKAI_REPLAY_ENABLED` unset | Capture mode — replay header silently ignored; live call still captured. |
| `X-Noukai-Replay` present + `NOUKAI_REPLAY_ENABLED=true` | Replay mode — SDK fetches session, serves from cassette. |

### Explicit `sessionId` option (R8)

> **Important:** passing `sessionId` explicitly to `Flow.execute()` (or
> `steps()` / `events()` / `executeAsync()`) **bypasses the active scope**.
> The SDK performs a one-shot fetch for that specific session id and serves
> the call from its cassette. This is an escape hatch for calling a different
> session inside an active replay scope — use it deliberately.

```typescript
// Inside a replay scope for session "abc-123":
const result = await noukai.flow("grade-3").execute({
  message: "Hello",
  sessionId: "xyz-789",  // fetches xyz-789 independently; does NOT consume
                         // a slot from the outer scope's abc-123 cassette
});
```

### Session fetch is idempotent (R3)

`GET /seq/sessions/{id}` is a read-only endpoint. The transport retries 5xx
responses by default (`maxRetries: 1`), so transient fetch failures are handled
automatically.

### Production safety

Replay is gated behind `NOUKAI_REPLAY_ENABLED=true`. A stray `X-Noukai-Replay`
header in production cannot redirect a real request to a cassette.

### Caveats

- Replay requires the flow / org `traceCaptureMode` to be `full` or `redacted`
  at the time of recording. If it was `off`, replay throws `ReplayNoSnapshotsError`.
- `executeAsync()` / job-based flows are not supported in replay v1. Attempting
  replay on a job execution throws `ReplayMissError` with an explicit message.
- Concurrent same-slug calls inside one scope (e.g. `Promise.all`) are matched
  by position; the SDK emits a warning when this is detected.
- See the [design doc](https://github.com/noukai/noukai/blob/main/development/noukai/docs/design-logs/2026/06Jun/20260605-SDK-replay-decorator/design.md)
  for the full spec.

## Flow versions

| `version`     | Behaviour                                                                 |
| ------------- | ------------------------------------------------------------------------- |
| `"draft"` *(default)* | Latest unpublished draft (what you see in the editor).            |
| `<integer>`   | A specific published version (e.g. `version: 3`).                         |
| `"production"`| **Not yet supported** — throws at call site until the server contract lands. |

Pin a version when calling from production code; use `"draft"` only in test and preview environments.

## Run traces

Every execution has an `executionId`. Use it to fetch trace data after the fact.

```typescript
const run = flow.run("exec_abc123");

// Whole-run trace (one attempt per step)
const trace = await run.trace();
console.log(trace.summary, trace.steps);

// Single step, optionally a specific attempt
const stepTrace = await run.stepTrace("step-1", { attempt: "latest" });
const allAttempts = await run.stepTrace("step-1", { attempt: "all" });

// Live trace stream (replays from DB, then tails Redis)
for await (const event of run.liveTrace()) {
  console.log(event);
}
```

## Errors

All errors extend `NoukaiError` and carry `statusCode`, `code`, `executionId`, `requestId`, and `responseBody` properties for diagnostics.

| Class                       | HTTP    | When                                               |
| --------------------------- | ------- | -------------------------------------------------- |
| `AuthenticationError`       | 401     | Missing or invalid API key.                        |
| `PermissionDeniedError`     | 403     | Key lacks access to the requested resource.        |
| `FlowNotFoundError`         | 404     | Slug or execution ID not found.                    |
| `InsufficientCreditsError`  | 402     | Org balance is insufficient or exhausted.          |
| `RateLimitError`            | 429     | Rate limited — `.retryAfter` (seconds) when present. |
| `FlowExecutionError`        | 5xx     | Server-side execution failure. Branch on `.code`.  |
| `APIConnectionError`        | n/a     | Network / DNS / TLS failure before any response.   |
| `APITimeoutError`           | n/a     | Request or job-wait exceeded its timeout.          |
| `ToolCallLimitError`        | n/a     | Client-side: `maxToolRounds` exhausted.            |

```typescript
import { FlowExecutionError, ServerErrorCode } from "@noukai/sdk";

try {
  await flow.execute({ message: "..." });
} catch (err) {
  if (err instanceof FlowExecutionError) {
    if (err.code === ServerErrorCode.BYOK_KEY_REJECTED) {
      // ...
    }
  }
  throw err;
}
```

`ServerErrorCode` is exported as a const enum-like object — see [`constants.ts`](src/constants.ts) for the full list (`FLOW_NOT_FOUND`, `INSUFFICIENT_CREDITS`, `TOOL_ITERATION_LIMIT`, `BYOK_KEY_REJECTED`, etc.).

## Timeouts, retries, cancellation

### Timeouts

- **Client default:** `timeout: 300_000` (ms) on `new Noukai({ ... })`.
- **Per-call override:** pass `timeout: 60_000` to any method.
- Triggers `APITimeoutError`.

### Retries

- **Default:** `maxRetries: 1` — one retry on retryable 5xx with exponential backoff.
- Non-retryable status codes are surfaced immediately.

### Cancellation

Both client- and call-level `AbortSignal` are supported.

```typescript
const controller = new AbortController();
const noukai = new Noukai({ signal: controller.signal });

setTimeout(() => controller.abort(), 5_000);
await flow.execute({ message: "..." });   // aborts after 5s
```

Per-call signals override the client signal for that one request.

## Logging

```typescript
const noukai = new Noukai({
  onLog: (event) => {
    // { phase: "request" | "response" | "retry",
    //   method, path, attempt, statusCode?, requestId?,
    //   requestBody?, responseBody? }
    logger.info(event);
  },
  logPayloads: true,   // include bodies — off by default to protect PII
});
```

The hook fires on every request, response, and retry attempt. `requestBody` and `responseBody` are omitted unless `logPayloads: true`.

## OpenTelemetry (opt-in)

The SDK can emit an [OpenTelemetry](https://opentelemetry.io/) span for each flow call into **your own** OTel backend (Datadog, Honeycomb, Jaeger, any OTLP collector) — so a Noukai call shows up on your traces next to your DB queries and HTTP calls. It is **off by default** and a true no-op when off (the SDK never imports OpenTelemetry unless you opt in).

`@opentelemetry/api` is an optional peer dependency — install it and turn it on with `otel: true`:

```bash
npm install @opentelemetry/api
```

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Noukai } from "@noukai/sdk";

// 1. Configure your OTel provider/exporter once, at app startup (your choice of backend).
const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
provider.register();

// 2. Opt the client in. Spans flow into the provider you registered above.
const noukai = new Noukai({ apiKey: "nk_...", org: "acme", project: "spelling", otel: true });
await noukai.flow("grade-3").execute({ message: "hello" }); // → span "noukai.flow.execute"
```

Each `execute()` / `executeAsync()` call produces one span of kind `CLIENT`:

| Span name | `noukai.flow.execute` · `noukai.flow.execute_async` |
|---|---|
| Attributes | `noukai.org`, `noukai.project`, `noukai.flow.slug`, `noukai.flow.version`, `noukai.execution_id`, `noukai.flow.status` |
| On error | records the exception and sets the span status to `ERROR` (the exception still propagates) |

Pass your own tracer instead of the global provider with `new Noukai({ ..., otel: true, tracer: myTracer })`. Because ESM resolves the optional dependency lazily, a missing `@opentelemetry/api` surfaces as a clear error on the first traced call.

> Per-step child spans (synthesized from `run.trace()`) and W3C `traceparent` propagation are planned follow-ups; `steps()` / `events()` streaming calls are not yet span-wrapped. Today's scope is the parent span on `execute` / `executeAsync`.

## Resource management

The client holds an HTTP connection pool. Release it explicitly when you're done:

```typescript
// Modern runtimes (Node 20+, TS 5.2+):
await using noukai = new Noukai();
// auto-disposes at scope exit

// Or manually:
const noukai = new Noukai();
try {
  // ...
} finally {
  await noukai.close();
}
```

`close()` is safe to call multiple times.

## Documentation

Full guides, API reference, and examples: <https://noukai.dev/docs/sdk/node/>

- [Agent-over-relay implementation guide](docs/AGENT_RELAY.md) — serve a flow to
  a browser, drive it keyless, and the `@noukai/agent` React layer, with the
  wire contract and a checklist (written for LLMs implementing relays).

## License

MIT — see [LICENSE](LICENSE).
