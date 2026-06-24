# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
