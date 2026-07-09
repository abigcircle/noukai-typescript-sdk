/**
 * Replay matcher — Phase 6 implementation.
 *
 * Matches user code execute() / events() / steps() calls to recorded
 * executions in the fetched session.
 *
 * Matching strategy (per BE design 20260605-BE-execution-session-grouping
 * §"The SDK matcher compares `flow.slug` first; falls back to `flow_id` if
 * needed"):
 *
 *  - The user-code call has (org, project, slug, flowId?). The SDK client is
 *    bound to one (org, project) context, so we match on **bare slug** (not
 *    `org/project/slug`). When the recorded execution's `slug` is null
 *    (e.g. the underlying flow has been deleted), we fall back to matching
 *    by `flowId`.
 *  - `execute(slug, ...)`: Nth call to the bare slug matches the Nth
 *    recorded execution for that slug with triggerType `"execute"`.
 *  - `events(slug, ...) / steps(slug, ...)`: same slug-positional rule with
 *    triggerType `"step"`.
 *
 * Q1 resolution: if `options.sessionId` is set AND differs from the scope's
 * session id, a one-shot fetch is performed for that explicit session and the
 * first execution matching the slug is returned (no cursor increment on the
 * scope).
 *
 * Q6: concurrent same-slug calls emit a console.warn.
 *
 * R10: executeAsync in REPLAY mode throws explicitly.
 */

import {
  FlowExecutionError,
  ReplayError,
  ReplayMissError,
} from "../errors.js";
import type { ExecuteResult, PausedResult } from "../types/responses.js";
import type { StreamEvent } from "../types/events.js";
import type { SessionExecution } from "../types/session.js";
import type { Transport } from "../transport.js";
import type { ScopeState, ReplayCursor } from "./state.js";
import { nextIndex } from "./state.js";
import { stripTraceSidecars } from "./snapshot.js";

// ---------------------------------------------------------------------------
// Internal: in-flight tracking (Q6 concurrent detection)
// ---------------------------------------------------------------------------

/** Augmented scope type used only within this module for in-flight tracking. */
interface ScopeWithInFlight extends ScopeState {
  _inFlight?: Set<string>;
}

function detectConcurrent(scope: ScopeState, slugKey: string, trigger: string): void {
  const s = scope as ScopeWithInFlight;
  s._inFlight ??= new Set<string>();
  const key = `${slugKey}::${trigger}`;
  if (s._inFlight.has(key)) {
    console.warn(
      `[noukai] Concurrent same-slug replay detected for ${slugKey} ` +
      `(${trigger}). Per design, this is undefined behavior in v1. ` +
      `Matching order may not reflect call order.`,
    );
  }
  s._inFlight.add(key);
}

// ---------------------------------------------------------------------------
// Slug + flowId predicate
// ---------------------------------------------------------------------------

/**
 * Predicate matching a recorded execution against a user-code call.
 *
 * Rule: bare slug matches when present; otherwise fall back to `flowId`.
 * Never matches when both the call and the recording are missing both
 * identifiers.
 *
 * @param ex          recorded execution (BE shape: bare slug, optional)
 * @param slug        bare slug from the user's `flow(slug)` call
 * @param triggerType filter to "execute" or "step" recordings
 */
function executionMatchesSlug(
  ex: SessionExecution,
  slug: string,
  triggerType: "execute" | "step",
): boolean {
  if (ex.triggerType !== triggerType) return false;
  // Primary key: bare slug.
  if (ex.slug !== null && ex.slug !== undefined && ex.slug !== "") {
    return ex.slug === slug;
  }
  // Fallback for deleted flows: match by flow_id. The user-code call site
  // does not have flow_id available, so this branch only matches when the
  // recording's slug is null/empty AND there's no other recording to match
  // against. In v1 we surface a ReplayMissError in that situation — the
  // caller can supply a session that has the flow intact. See design Q5.
  return false;
}

// ---------------------------------------------------------------------------
// Core: find the Nth execution for a (slug, triggerType) pair
// ---------------------------------------------------------------------------

function findNthForSlug(
  scope: ScopeState,
  slug: string,
  triggerType: "execute" | "step",
  cursorKey: "executeCursor" | "stepFirstCallCursor",
): SessionExecution {
  if (scope.fetchedSession === null) {
    throw new ReplayMissError(
      `Replay miss: no session loaded for scope. Cannot replay slug ${slug}.`,
    );
  }
  const cursor: ReplayCursor = scope[cursorKey];
  const n = nextIndex(cursor, slug);

  const matches = scope.fetchedSession.executions.filter(
    (e) => executionMatchesSlug(e, slug, triggerType),
  );

  if (n >= matches.length) {
    const totalExecutions = scope.fetchedSession.executions.length;
    const nullSlugCount = scope.fetchedSession.executions.filter(
      (e) => e.slug === null || e.slug === undefined || e.slug === "",
    ).length;
    const hint =
      nullSlugCount > 0
        ? ` Note: ${String(nullSlugCount)} recorded execution(s) have a null/empty slug ` +
          `(deleted flow); they cannot be matched by slug name. Use a session captured ` +
          `while the flow still existed.`
        : "";
    throw new ReplayMissError(
      `Replay miss: user code made call #${String(n + 1)} to slug ${slug} (${triggerType}), ` +
      `but the session has only ${String(matches.length)} recorded ${triggerType} ` +
      `execution(s) for that slug out of ${String(totalExecutions)} total. ` +
      `Either the code diverged from the recording, or the recording is incomplete.${hint}`,
    );
  }

  const ex = matches[n];
  if (ex === undefined) {
    // Unreachable: n < matches.length guard above ensures this.
    throw new ReplayMissError(`Replay miss: index ${String(n)} out of bounds.`);
  }
  scope.consumedExecutionIds.add(ex.executionId);
  return ex;
}

// ---------------------------------------------------------------------------
// One-shot fetch for Q1: explicit sessionId kwarg inside a REPLAY scope
// ---------------------------------------------------------------------------

async function findFirstForSlugInExplicitSession(
  transport: Transport,
  slug: string,
  triggerType: "execute" | "step",
  explicitSessionId: string,
): Promise<SessionExecution> {
  const { fetchSession } = await import("./fetcher.js");
  // Use the caller's authenticated transport so the explicit-session fetch
  // attaches the API key (mirrors the Python matcher in
  // replay/matcher.py::_find_first_in_explicit_session_async).
  const session = await fetchSession(transport, explicitSessionId);

  const matches = session.executions.filter(
    (e) => executionMatchesSlug(e, slug, triggerType),
  );

  if (matches.length === 0) {
    throw new ReplayMissError(
      `Replay miss (explicit sessionId): session ${explicitSessionId} has no ` +
      `recorded ${triggerType} execution for slug ${slug}.`,
    );
  }

  const ex = matches[0];
  if (ex === undefined) {
    // Unreachable: matches.length > 0 guard above ensures this.
    throw new ReplayMissError(`Replay miss: index 0 out of bounds.`);
  }
  // NOTE: We do NOT add to scope.consumedExecutionIds because this execution
  // belongs to a different session (the explicit one). The scope's leftover
  // check covers only the scope's own session.
  return ex;
}

// ---------------------------------------------------------------------------
// Materialize: build ExecuteResult (or re-raise recorded error) from an execution
// ---------------------------------------------------------------------------

function materializeExecuteResult(
  ex: SessionExecution,
  scopeSessionId: string | null,
): ExecuteResult {
  // If the execution recorded an error, re-raise it faithfully.
  if (ex.errorAtStep !== undefined && ex.errorAtStep !== null) {
    const failedStep = ex.steps.find((s) => s.stepId === ex.errorAtStep);
    if (failedStep?.errorSnapshot != null) {
      const err = failedStep.errorSnapshot;
      const message =
        typeof err.message === "string" ? err.message : "Recorded error";
      const code =
        typeof err.code === "string" ? err.code : undefined;
      throw new FlowExecutionError(message, {
        ...(code !== undefined ? { code } : {}),
        executionId: ex.executionId,
      });
    }
  }

  const lastStep = ex.steps[ex.steps.length - 1];

  const result: ExecuteResult = {
    status: "completed",
    // Strip reserved trace sidecars (e.g. __rendered_prompt__) so the replayed
    // result matches the live execute() result, which excludes them.
    result: stripTraceSidecars(lastStep?.outputSnapshot),
    executionId: ex.executionId,
    flowId: ex.flowId ?? "",
    blockCount: ex.steps.length || 1,
    // Phase 5 surface: sessionId on the result (R1). Use scope session, not
    // execution_id, to match Phase 5's API contract (gap analysis note 2).
    ...(scopeSessionId !== null ? { sessionId: scopeSessionId } : {}),
    requiresToolCalls: false as const,
  };
  return result;
}

// ---------------------------------------------------------------------------
// matchExecute — main entrypoint for Flow.execute() in REPLAY mode
// ---------------------------------------------------------------------------

/**
 * Match an execute() call to the next recorded execution for this slug.
 *
 * Per the unified Q1 rule applied to execute / steps / events:
 *  - No `options.sessionId` OR `options.sessionId === scope.sessionId` →
 *    match against the scope's cassette (positional).
 *  - Explicit `options.sessionId !== scope.sessionId` → one-shot fetch of
 *    that session, match by slug (first match).
 *
 * @throws ReplayMissError when no matching recorded execution is available.
 * @throws FlowExecutionError when the recorded execution had an error.
 * @throws ReplayError if executeAsync is attempted (R10).
 */
export async function matchExecute(
  scope: ScopeState,
  transport: Transport,
  org: string,
  project: string,
  slug: string,
  options: Record<string, unknown>,
): Promise<ExecuteResult | PausedResult> {
  // org/project are not part of the wire match key (BE matches on bare slug
  // within the (org, project) the SDK client is bound to). Reserved for
  // logging / future cross-project diagnostics.
  void org;
  void project;

  // Q1: explicit sessionId kwarg that differs from the scope's session id →
  // one-shot fetch of the explicit session.
  const explicitSessionId =
    typeof options.sessionId === "string" ? options.sessionId : undefined;

  if (explicitSessionId !== undefined && explicitSessionId !== scope.sessionId) {
    // One-shot fetch for the explicit session. Also advance the scope's
    // positional cursor for this slug so the "skipped" scope execution is
    // counted as consumed (prevents a spurious ReplayLeftoverError at scope exit).
    const ex = await findFirstForSlugInExplicitSession(
      transport,
      slug,
      "execute",
      explicitSessionId,
    );
    // Advance the scope's execute cursor and mark the scope-level execution
    // as consumed so the leftover check is satisfied.
    if (scope.fetchedSession !== null) {
      const scopeCursor = scope.executeCursor;
      const n = nextIndex(scopeCursor, slug);
      const scopeMatches = scope.fetchedSession.executions.filter(
        (e) => executionMatchesSlug(e, slug, "execute"),
      );
      const skippedEx = scopeMatches[n];
      if (skippedEx !== undefined) {
        scope.consumedExecutionIds.add(skippedEx.executionId);
      }
    }
    return materializeExecuteResult(ex, explicitSessionId);
  }

  // Normal slug-positional path.
  detectConcurrent(scope, slug, "execute");
  const ex = findNthForSlug(scope, slug, "execute", "executeCursor");
  return materializeExecuteResult(ex, scope.sessionId);
}

// ---------------------------------------------------------------------------
// matchEvents — entry point for Flow.events() / Flow.steps() in REPLAY mode
// ---------------------------------------------------------------------------

/**
 * Match a step/events() call to the next recorded step-trigger execution for
 * this slug, applying the same explicit-sid one-shot fetch rule as execute().
 *
 * @throws ReplayMissError when no matching recorded execution is available.
 */
export async function* matchEvents(
  scope: ScopeState,
  transport: Transport,
  org: string,
  project: string,
  slug: string,
  options: Record<string, unknown>,
): AsyncIterable<StreamEvent> {
  void org;
  void project;

  const explicitSessionId =
    typeof options.sessionId === "string" ? options.sessionId : undefined;

  // Unified Q1 rule (matches execute()): explicit different sid → one-shot fetch.
  if (explicitSessionId !== undefined && explicitSessionId !== scope.sessionId) {
    const ex = await findFirstForSlugInExplicitSession(
      transport,
      slug,
      "step",
      explicitSessionId,
    );
    // Mirror execute()'s scope-cursor advance so leftover-check passes.
    if (scope.fetchedSession !== null) {
      const scopeCursor = scope.stepFirstCallCursor;
      const n = nextIndex(scopeCursor, slug);
      const scopeMatches = scope.fetchedSession.executions.filter(
        (e) => executionMatchesSlug(e, slug, "step"),
      );
      const skippedEx = scopeMatches[n];
      if (skippedEx !== undefined) {
        scope.consumedExecutionIds.add(skippedEx.executionId);
      }
    }
    const { reconstructEvents } = await import("./sseReconstructor.js");
    yield* reconstructEvents(ex);
    return;
  }

  detectConcurrent(scope, slug, "step");
  const ex = findNthForSlug(scope, slug, "step", "stepFirstCallCursor");
  const { reconstructEvents } = await import("./sseReconstructor.js");
  yield* reconstructEvents(ex);
}

// ---------------------------------------------------------------------------
// R10: executeAsync raises explicitly in REPLAY mode
// ---------------------------------------------------------------------------

/**
 * Called when `Flow.executeAsync()` is invoked inside a REPLAY scope.
 * Jobs are not supported in replay v1.
 */
export function replayExecuteAsyncNotSupported(): never {
  throw new ReplayError(
    "Replay does not support execute_async() / jobs in v1. " +
    "Use execute() or events() / steps() instead.",
  );
}
