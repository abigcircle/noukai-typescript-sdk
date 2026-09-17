import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ScopeMode, type ScopeModeValue, type ScopeState, newScopeState } from "./state.js";
import { REPLAY_ENABLED_ENV_VAR } from "../constants.js";
import { ReplayNoSnapshotsError, ReplayLeftoverError } from "../errors.js";
import type { Transport } from "../transport.js";

/** The subset of AsyncLocalStorage the SDK actually uses. */
interface ScopeStorage {
  getStore(): ScopeState | undefined;
  run<R>(store: ScopeState, callback: () => R): R;
}

/**
 * Module-level scope storage; empty when no scope is active.
 *
 * Node gets a real `AsyncLocalStorage` for async-context tracking. In the browser
 * `node:async_hooks` is externalized to an empty module (so `AsyncLocalStorage` is
 * `undefined`) and replay/capture is a server-only feature the browser never runs,
 * so fall back to a no-op that reports "no active scope". This keeps the module
 * side-effect-free off-Node — importing the SDK barrel (e.g. for `createRelayFlow`)
 * no longer throws `AsyncLocalStorage is not a constructor` in a browser bundle.
 */
export const scopeStorage: ScopeStorage =
  typeof AsyncLocalStorage === "function"
    ? new AsyncLocalStorage<ScopeState>()
    : {
        getStore: () => undefined,
        run: <R>(_store: ScopeState, callback: () => R): R => callback(),
      };

export function currentSessionId(): string | null {
  const s = scopeStorage.getStore();
  return s?.sessionId ?? null;
}

export function currentScope(): ScopeState | null {
  return scopeStorage.getStore() ?? null;
}

function replayEnvEnabled(): boolean {
  const v = (process.env[REPLAY_ENABLED_ENV_VAR] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface ReplayScopeOptions {
  /**
   * Replay session id; when set AND NOUKAI_REPLAY_ENABLED=true, opens REPLAY
   * scope. When unset (or env var is unset) opens a CAPTURE scope (or NORMAL
   * if `capture=false`).
   *
   * Q5 resolution: env var absent + replaySessionId set → CAPTURE mode (test 18).
   */
  replaySessionId?: string;
  /**
   * Disable capture in this sub-scope. Default true (capture).
   * Set to false when NORMAL mode is desired without an explicit replay session.
   */
  capture?: boolean;
  /**
   * Optional override transport for fetching the session in REPLAY mode.
   * The middleware passes the client's transport; framework-agnostic callers
   * who only have the user-level callback should pass their own client's
   * transport here.
   */
  transport?: Transport;
}

/**
 * Open a replay scope for the duration of `fn`. Async equivalent of the
 * `@noukai.replay` Python decorator + context manager.
 *
 * In REPLAY mode the session is pre-fetched before `fn` is called; throws
 * before `fn` runs if fetch fails.
 *
 * Precedence rule (Q5 resolution):
 * - `NOUKAI_REPLAY_ENABLED` env var absent + replay header present → CAPTURE mode.
 * - `NOUKAI_REPLAY_ENABLED=true` + `replaySessionId` set → REPLAY mode.
 * - Neither → CAPTURE mode (if `capture=true`) or NORMAL mode (if `capture=false`).
 *
 * Q1 resolution:
 * - An explicit `sessionId` kwarg on `Flow.execute`/`steps`/`events` inside
 *   a REPLAY scope triggers a one-shot fetch for that session id only.
 *
 * @throws ReplayForbiddenError (403) / ReplaySessionNotFoundError (404)
 *   / ReplayInvalidSessionError (400) / ReplayNoSnapshotsError on session fetch.
 */
export async function replayScope<T>(
  fn: () => Promise<T> | T,
  options: ReplayScopeOptions = {},
): Promise<T> {
  let mode: ScopeModeValue;
  let sid: string | null;

  if (options.replaySessionId !== undefined && replayEnvEnabled()) {
    mode = ScopeMode.REPLAY;
    sid = options.replaySessionId;
  } else if (options.capture !== false) {
    // Q5: env var unset + replaySessionId set → CAPTURE (generate a fresh sid)
    mode = ScopeMode.CAPTURE;
    sid = randomUUID();
  } else {
    mode = ScopeMode.NORMAL;
    sid = null;
  }

  const scope: ScopeState = newScopeState(mode, sid);

  // R2: emit scope_open event via transport log hook when a transport is
  // provided. `_emitLog` is a no-op when no onLog callback is configured.
  options.transport?._emitLog({ phase: "scope_open", mode, sessionId: sid });

  if (mode === ScopeMode.REPLAY) {
    // Dynamic import to avoid circular: fetcher → errors → scope.
    // options.replaySessionId is defined here — we checked it in the if-guard above.
    // transport is optional: when present its auth + base URL are used; when absent
    // the fetcher calls bare fetch() against the env-derived base URL (test scenarios).
    const replayId = options.replaySessionId ?? "";
    const { fetchSession } = await import("./fetcher.js");
    scope.fetchedSession = await fetchSession(options.transport, replayId);
    validateSnapshotsAvailable(scope);
  }

  try {
    return await scopeStorage.run(scope, async () => {
      const result = await fn();
      if (mode === ScopeMode.REPLAY) {
        checkLeftovers(scope);
      }
      return result;
    });
  } finally {
    // R2: emit scope_close — always fires, even on error.
    options.transport?._emitLog({ phase: "scope_close", mode, sessionId: sid });
  }
}

function validateSnapshotsAvailable(scope: ScopeState): void {
  const session = scope.fetchedSession;
  if (session === null) return;
  for (const ex of session.executions) {
    if (!ex.snapshotsAvailable) {
      throw new ReplayNoSnapshotsError(
        `Session ${String(scope.sessionId)} has execution ${ex.executionId} with ` +
        `snapshotsAvailable=false (traceCaptureMode=${String(ex.traceCaptureMode)}). ` +
        `Cannot replay. Set traceCaptureMode to 'full' or 'redacted' and re-record.`,
      );
    }
  }
}

function checkLeftovers(scope: ScopeState): void {
  const session = scope.fetchedSession;
  if (session === null) return;
  const all = new Set(session.executions.map(e => e.executionId));
  const leftover: string[] = [];
  for (const id of all) if (!scope.consumedExecutionIds.has(id)) leftover.push(id);
  if (leftover.length > 0) {
    throw new ReplayLeftoverError(
      `Session ${String(scope.sessionId)} has ${String(leftover.length)} unconsumed executions ` +
      `at scope exit: ${leftover.sort().join(", ")}.`,
    );
  }
}
