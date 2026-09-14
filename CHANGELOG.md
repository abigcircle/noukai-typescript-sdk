# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] — 2026-09-14

### Fixed

- **Browser-safe replay scope** — `replay/scope.ts` constructed a module-level
  `AsyncLocalStorage` at import time, so importing the SDK barrel in a browser
  bundle (e.g. `createRelayFlow` via `@noukai/agent`) threw `AsyncLocalStorage is
  not a constructor`: bundlers externalize `node:async_hooks` to an empty module
  off-Node, leaving the constructor `undefined`. The scope storage now falls back
  to a no-op ("no active scope") when `AsyncLocalStorage` is unavailable. Node
  behavior is unchanged — replay/capture is server-only — and the package now
  honors its declared `"sideEffects": false` in browser bundlers.

## [0.4.0] — 2026-09-14

### Added

- **`messages` on the request model (F6)** — `flow.execute()` accepts a
  structured `messages?: ChatMessage[]`, mutually exclusive with `message`, for
  chat/agent flows (design `20260903-SDK-agent-relay`, PR-2). A new permissive
  `ChatMessage` type (`role`/`content`/`toolCalls`/`toolCallId`/`name`,
  **camelCase** wire, open index signature) tracks
  `llm_service.models.ChatMessage` and is exported. This brings the SDK request
  model back in sync with the server's `SeqflowExecuteRequest`.
- **Wire contents are camelCase (camelCase alignment).** `ChatMessage`'s tool
  fields are `toolCalls`/`toolCallId` (were `tool_calls`/`tool_call_id`), so the
  whole Noukai wire — envelope and message/tool contents — is camelCase. The
  router-ai-slugs execute API accepts and emits camelCase; snake_case now lives
  only at the external LLM-provider boundary. Callers building tool-result
  messages for a resume should use `{ role: "tool", toolCallId, content }`.
- **Client-side validation of the fresh-call contract** — `message`/`messages`
  are rejected together, `messages[]` roles are restricted to
  `user`/`assistant`/`tool` (a `system`/`function` turn throws before the wire),
  and a `console.warn` fires as a `messages` payload approaches the server's
  1 MB cap (`MESSAGES_TOO_LARGE`).
- **Execute-transport seam** — a transport-pluggable `ExecuteTransport`
  (`send(payload) -> { status, body }`) interface makes the yield/resume
  tool-calling loop reusable across transports. `Flow.execute()` now routes
  resume through a `DirectExecuteTransport` (today's key-holding behavior,
  unchanged — the existing tool-call tests are the regression guard).
- **Keyless relay entrypoint** — `createRelayFlow({ url, fetch? })` (and the
  `RelayFlow` class) run the **same** loop over a `RelayExecuteTransport` that
  POSTs the raw payload to a relay URL with no `nk_` key and no `/seq` path (the
  browser / server-to-server / CLI agent position). Both fresh-call modes
  (`message` and `messages`) are supported. `createRelayFlow`, `RelayFlow`, and
  `RelayExecuteTransport` are exported.

- **Verbatim relay transport mode + relay adapters** (design
  `20260903-SDK-agent-relay`, PR-1) — a browser or any keyless client drives a
  tool-calling flow without ever seeing your `nk_` key; your server is a thin
  keyholder proxy. `RequestOptions` gains `raiseForStatus?: boolean` (default
  `true`; when `false`, a non-2xx is returned as a `TransportResponse` rather
  than thrown — retryable retries still apply). New relay handlers:
  `noukaiRelayHandler(...)` (`@noukai/sdk/adapters/express`), `createRelayRoute(...)`
  (`@noukai/sdk/adapters/nextjs`), and the framework-agnostic
  `@noukai/sdk/adapters/relay` core (`RelayBounds`, `boundAndParseBody`,
  `forwardToFlow`). The relay bounds the raw body before parse (`413`), bounds
  message counts, rejects malformed JSON (`400`), awaits your `authorize` hook
  (throw to reject; a numeric `status` is honored, else `403`), then forwards
  verbatim to `/seq/{org}/{project}/{slug}/execute` with the `nk_` bearer
  injected, relaying the upstream `(status, body)` verbatim (non-JSON →
  `{ detail: "UPSTREAM_NON_JSON" }`). It never logs the key or the body.

### Changed

- **Client round limit reconciled to one value.** The keyless relay loop uses
  the SDK's `DEFAULT_MAX_TOOL_ROUNDS` (**10**), reconciling the two historical
  limits (SDK `10` vs the extracted `@noukai/agent`'s `12`). When
  `@noukai/agent` is re-expressed over this loop (PR-3), its effective limit
  becomes `10` — a deliberate, documented one-round-fewer change for that path.

### Fixed

Post-review parity and correctness fixes (design `20260903-SDK-agent-relay`),
landed with the matching Python fixes in lockstep:

- **Relay forward no longer retries the non-idempotent POST.** The relay
  forwards with `idempotent: false`, so a transient upstream 429/5xx is relayed
  verbatim instead of silently re-submitting the `/execute` POST (a duplicate
  flow-run risk, and a divergence from the Python relay). `RequestOptions` gains
  `idempotent?: boolean`.
- **Empty `messages: []` is omitted from the wire** (matches Python), and a
  `messages` entry missing a string `role` is rejected client-side rather than
  forwarded.
- **The `messages` size soft-warning fires once per process** (was every call) —
  parity with the Python peer.
- **An explicit `maxToolRounds` of `0`/negative is honored** (raises
  immediately) instead of being clamped to the default — matches the Python loop.
- **The relay `version`** rejects an invalid value (e.g. `"production"`) instead
  of silently coercing it to `draft` and serving the wrong flow version.
- **The Next.js relay** handles a null-body upstream status (204/205/304)
  instead of throwing a `TypeError` that surfaced as a 500.
- **Typed errors from non-standard error bodies** carry a readable `.message`
  (a top-level `error`/`message`, else the JSON) instead of `"[object Object]"`.

## [0.3.0] — 2026-06-23

### Breaking
- `StepStarted.stepIndex`, `StepPaused.stepIndex`, and `StepCompleted.stepIndex`
  are now **required** and **guaranteed to be flow-absolute, consumer-frame
  indices** stamped by the SDK before each event is yielded. Previously:
  optional, and (when present from the server) segment-local — every `/step`
  call's events restarted at `0`, leaking the SDK's pause/resume transport
  segmentation. Consumers relying on `event.stepIndex ?? fallback` can drop
  the fallback. The new contract holds for both live SSE and replay-mode
  reconstruction. `step_paused.stepIndex` reports the index of the
  just-completed step (the pause is "for" that step), matching the
  `step_completed` that precedes it.
- `StepCompleted` gains a `stepIndex: number` field (previously absent from
  the wire and the type).

## [0.2.0] — 2026-06-06

### Breaking
- `LogEvent.phase` widened from `"request" | "response" | "retry"` to
  `"request" | "response" | "retry" | "scope_open" | "scope_close"`. TypeScript
  consumers that exhaustively switch on `phase` (e.g. with `assertNever`) need
  to add the two new cases. Untyped JS consumers are unaffected.

### Added
- `traceScope` and `currentSessionId` / `currentScope` for grouping multiple
  SDK calls under one session id, enabling later replay without re-hitting LLM
  providers.
- Nine replay error classes: `ReplayError`, `ReplayMissError`,
  `ReplayLeftoverError`, `ReplayForbiddenError`, `ReplaySessionNotFoundError`,
  `ReplaySessionExpiredError`, `ReplayInvalidSessionError`,
  `ReplayNoSnapshotsError`, `ReplayDisabledError`.
- `sessionId` option on `Flow.execute()`, `Flow.steps()`, `Flow.events()`, and
  `Flow.executeAsync()` — explicitly tags the request's `X-Session-Id` header
  and bypasses the active scope.
- `sessionId` option on `NoukaiOptions` — client-level default session id.
- `sessionId` property on `ExecuteResult`, `PausedResult`, and `JobAccepted` —
  surfaces the captured or replayed session id.
- Express middleware: `import { noukaiTraceMiddleware } from
  "@noukai/sdk/adapters/express"` — reads `X-Noukai-Replay`, opens a
  `traceScope`, and writes `X-Noukai-Session` on the response.
- Next.js App Router HOF: `import { withNoukaiTrace } from
  "@noukai/sdk/adapters/nextjs"` — same semantics for App Router route
  handlers.
- Outbound `X-Session-Id` header is captured automatically inside a
  `traceScope` (capture mode) or forwarded in replay mode.
- `X-Noukai-Session` response header injected by framework adapters so callers
  can retrieve the session id without code changes.
- Replay gated behind `NOUKAI_REPLAY_ENABLED=true` env var — a stray
  `X-Noukai-Replay` header in production does not redirect a real request.
- `mode` and `sessionId` fields on `LogEvent` for scope lifecycle observability.
- Centralized URL audit registry at `src/paths.ts` — single file lists every
  backend route the SDK calls (delegates: flow execute/step/jobs, run trace,
  replay session). Auditing the wire surface is one file read.

### Fixed
- Replay matcher now compares against the BE's bare `flow.slug` (e.g.
  `"grade-3"`), not the synthesized `org/project/slug` that fixtures
  previously used. Replay against the real backend now actually matches
  recorded executions.
- `SessionExecution` model aligned with the BE schema: `status` includes
  `"pending"` and `"cancelled"`; `flowId`, `slug`, `triggerType`,
  `traceCaptureMode`, and `errorAtStep` are now Optional so the SDK does
  not crash when the underlying flow has been deleted.
- Reserved-header guard on `extraHeaders`: a misconfigured caller cannot
  overwrite `Authorization`, `X-Noukai-API-Version`, `User-Agent`,
  `X-Request-ID`, `Content-Type`, or `Cookie` via per-request headers.
- Unified `Flow.execute() / steps() / events()` REPLAY-mode dispatch — all
  three now apply the same rule when an explicit `sessionId` matches or
  differs from the scope. Previously `events()` and `steps()` made a live
  call for explicit-sid-matching-scope, asymmetric with `execute()`.

### Requires
- Backend session-grouping endpoint per BE design
  20260605-BE-execution-session-grouping (routes `GET /seq/sessions/{id}`,
  `X-Session-Id` grouping on `/execute` and `/step`).

## [0.1.0] — 2026-06-XX

### Added
- Initial release.
- `Noukai` class with `Symbol.asyncDispose` for `await using` support.
- `Flow.execute()`, `Flow.executeAsync()`, `Flow.steps()`, `Flow.events()`.
- `Flow.run(id).trace()`, `stepTrace()`, `liveTrace()`.
- Tool-call auto-resume via `toolHandler` option; manual mode via `PausedResult.resume()` and `ToolCallsRequired.resume()`.
- Typed discriminated-union events for SSE streams.
- Exception class hierarchy mapped to HTTP status; server error codes on `.code`.
- Universal runtime: Node 18+, Bun, Deno, Cloudflare Workers, Vercel Edge.
