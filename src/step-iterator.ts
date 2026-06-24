/**
 * Step iterator — drives `/seq/.../step` and yields typed `StreamEvent`s.
 *
 * Owns the per-iteration cursor (`executionId`, `accumulatedOutputs`,
 * `stepIndex`) and the tool-call branching state, threading them across
 * successive `/step` calls.
 *
 * Two driver modes, selected at construction time:
 *  - `yieldOnlyStepCompleted = true`  → backs `flow.steps()` (filters down to
 *    just `StepCompleted`).
 *  - `yieldOnlyStepCompleted = false` → backs `flow.events()` (yields every
 *    typed event including `ToolCallsRequired`, `StepPaused`, etc.).
 *
 * Tool-call branching:
 *  - If `opts.toolHandler` is set, the iterator awaits the handler internally,
 *    stashes the tool messages in `_pendingToolMessages`, closes the current
 *    inner SSE stream, and re-issues `/step` on the next `next()` call.
 *  - If no handler is set, the iterator attaches a `resume()` closure to the
 *    `ToolCallsRequired` event and yields it. The caller invokes
 *    `await event.resume({toolResults})`, which mutates the iterator's
 *    `_pendingToolMessages` / closes the inner stream — so the user's next
 *    iteration of the for-await loop transparently reopens `/step` with the
 *    carried tool state.
 */

import type { StepRequest } from "./types/requests.js";
import type { StreamEvent, ToolCallsRequired } from "./types/events.js";
import type { Flow, EventsOptions } from "./flow.js";
import { parseSSEStream } from "./streaming.js";
import { ToolCallLimitError } from "./errors.js";
import { DEFAULT_MAX_TOOL_ROUNDS, HEADER_SESSION_ID } from "./constants.js";
import { flowStepPath } from "./paths.js";
import { currentScope } from "./replay/scope.js";

// ---------------------------------------------------------------------------
// Internal option shape
// ---------------------------------------------------------------------------

interface IteratorOptions extends EventsOptions {
  /** When true, only `step_completed` events are yielded to the caller. */
  yieldOnlyStepCompleted: boolean;
}

// ---------------------------------------------------------------------------
// EventIterator
// ---------------------------------------------------------------------------

/**
 * `AsyncIterable` + `AsyncIterator` in a single class.
 *
 * Implements both protocols so callers can either use it directly with
 * `for await` (via the `[Symbol.asyncIterator]()` method, which returns
 * `this`) or call `next()` manually.
 *
 * The driver loop is `next()` — it loops internally until it either has an
 * event to yield or the flow has completed.
 */
export class EventIterator implements AsyncIterable<StreamEvent>, AsyncIterator<StreamEvent> {
  private _executionId: string | undefined;
  private _accumulatedOutputs: Record<string, unknown> = {};
  private _stepIndex = 0;
  private _toolRounds = 0;
  private _pendingToolMessages: Record<string, unknown>[] | null = null;
  private _pendingIterationsUsed = 0;
  private _flowComplete = false;
  private _currentInner: AsyncIterator<StreamEvent> | null = null;
  private readonly _initialMessage: string | undefined;

  constructor(
    private readonly flow: Flow,
    private readonly opts: IteratorOptions,
  ) {
    this._initialMessage = opts.message;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<StreamEvent>> {
    while (!this._flowComplete) {
      // Open a new /step stream if we don't have one (first iteration, after
      // protocol pause, after tool-call resume, or after stream EOF without
      // flow_completed).
      if (this._currentInner === null) {
        const req = this._buildRequest();
        // Reset pending tool state — it's now embedded in the request.
        this._pendingToolMessages = null;
        this._pendingIterationsUsed = 0;

        // Phase 4: inject X-Session-Id from scope / client default / per-call option
        const scope = currentScope();
        const effectiveSid =
          this.opts.sessionId ??
          this.flow._transport.defaultSessionId ??
          scope?.sessionId ??
          null;
        const extraHeaders: Record<string, string> = {};
        if (effectiveSid !== null) {
          extraHeaders[HEADER_SESSION_ID] = effectiveSid;
        }

        const version = this.opts.version ?? "draft";
        const url = flowStepPath(
          this.flow.org,
          this.flow.project,
          this.flow.slug,
          this.flow._pathVersion(version),
        );
        const byteStream = this.flow._transport.stream("POST", url, {
          json: req,
          ...(this.opts.signal !== undefined ? { signal: this.opts.signal } : {}),
          ...(this.opts.timeout !== undefined ? { timeout: this.opts.timeout } : {}),
          ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
        });
        this._currentInner = parseSSEStream(byteStream)[Symbol.asyncIterator]();
      }

      const result = await this._currentInner.next();
      if (result.done === true) {
        // Inner SSE stream ended without a flow_completed or step_paused —
        // close it and let the loop re-issue /step. (Defensive: server should
        // always emit a terminator, but we don't want to hang.)
        this._currentInner = null;
        continue;
      }
      const event: StreamEvent = result.value;

      // ----------------------------------------------------------------------
      // Cursor + state tracking
      // ----------------------------------------------------------------------

      if (event.type === "run_started") {
        if (event.executionId !== undefined && event.executionId !== "") {
          this._executionId = event.executionId;
        }
        if (!this.opts.yieldOnlyStepCompleted) {
          return { value: event, done: false };
        }
        continue;
      }

      if (event.type === "step_completed") {
        this._accumulatedOutputs[event.stepId] = event.output;
        this._stepIndex++;
        // step_completed always yields (it's the keystone for steps()).
        return { value: event, done: false };
      }

      if (event.type === "step_paused") {
        // Protocol pause between steps — close inner stream so we reopen on
        // next iteration.
        this._currentInner = null;
        if (!this.opts.yieldOnlyStepCompleted) {
          return { value: event, done: false };
        }
        continue;
      }

      if (event.type === "step_error") {
        // Terminal — yield then stop.
        this._flowComplete = true;
        return { value: event, done: false };
      }

      if (event.type === "flow_completed") {
        this._flowComplete = true;
        if (!this.opts.yieldOnlyStepCompleted) {
          return { value: event, done: false };
        }
        // steps() mode: drop the terminator, drain the loop.
        continue;
      }

      if (event.type === "tool_calls_required") {
        this._toolRounds++;
        const maxRounds = this.opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

        if (this.opts.toolHandler !== undefined) {
          if (this._toolRounds > maxRounds) {
            throw new ToolCallLimitError(
              `Tool call loop exceeded maxToolRounds=${String(maxRounds)}`,
              {
                code: "TOOL_CALL_LIMIT_CLIENT",
                executionId: event.executionId,
              },
            );
          }
          const handlerResult = await Promise.resolve(this.opts.toolHandler(event.toolCalls));
          this._pendingToolMessages = [...event.toolCallMessages, ...handlerResult];
          this._pendingIterationsUsed = event.iterationsUsed;
          this._currentInner = null; // re-issue /step with tool state
          continue;
        }

        // No handler — attach .resume() and yield to caller.
        this._attachEventResume(event);
        return { value: event, done: false };
      }

      // step_started, step_input, step_output — yield in raw mode, drop in
      // steps() mode.
      if (!this.opts.yieldOnlyStepCompleted) {
        return { value: event, done: false };
      }
      // steps() mode: continue the loop.
    }

    // Sentinel return for protocol completeness.
    return { value: undefined as never, done: true };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _buildRequest(): StepRequest {
    // `message` is only sent on the first /step call (when stepIndex===0 and
    // we're not mid-tool-resume). Subsequent calls send `null` to signal "use
    // server-side state".
    const isFirstFreshCall = this._stepIndex === 0 && this._pendingToolMessages === null;
    const message = isFirstFreshCall ? (this._initialMessage ?? null) : null;

    const req: StepRequest = {
      stepIndex: this._stepIndex,
      accumulatedOutputs: this._accumulatedOutputs,
      message,
      parameters: this._stepIndex === 0 ? (this.opts.parameters ?? {}) : {},
      inputOverrides: this.opts.inputOverrides ?? {},
      runRemaining: this.opts.runRemaining ?? false,
      iterationsUsed: this._pendingIterationsUsed,
      trace: this.opts.trace ?? false,
    };

    if (this._executionId !== undefined) req.executionId = this._executionId;
    if (this.opts.blockOverrides !== undefined) req.blockOverrides = this.opts.blockOverrides;
    if (this.opts.tools !== undefined) req.tools = this.opts.tools;
    if (this.opts.toolChoice !== undefined) req.toolChoice = this.opts.toolChoice;
    if (this._pendingToolMessages !== null) req.toolCallMessages = this._pendingToolMessages;

    return req;
  }

  /**
   * Attach a `.resume()` closure to a `ToolCallsRequired` event. The closure
   * captures `this` — when invoked, it mutates the iterator's pending tool
   * state and closes the inner stream so the user's next iteration reopens
   * `/step`.
   *
   * Uses `Object.defineProperty` (matching Phase 5's `attachResume` pattern)
   * so the property is non-enumerable (does not leak into `JSON.stringify`)
   * and to bypass the readonly-method declaration on the interface.
   */
  private _attachEventResume(event: ToolCallsRequired): void {
    // No await needed inside resumeFn — it only mutates iterator state — but
    // the interface declares it returns Promise<void> for symmetry with
    // potential future async cleanup. Use an explicit Promise wrapper rather
    // than `async` to keep the lint config (require-await) happy.
    const resumeFn = ({
      toolResults,
    }: {
      toolResults: Record<string, unknown>[];
    }): Promise<void> => {
      this._pendingToolMessages = [...event.toolCallMessages, ...toolResults];
      this._pendingIterationsUsed = event.iterationsUsed;
      this._currentInner = null; // next next() will re-issue /step
      return Promise.resolve();
    };

    Object.defineProperty(event, "resume", {
      value: resumeFn,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory helpers (used by Flow.steps / Flow.events)
// ---------------------------------------------------------------------------

/** @internal */
export function makeStepsIterator(
  flow: Flow,
  opts: EventsOptions,
): AsyncIterable<StreamEvent> {
  // In REPLAY mode, always delegate to the matcher. The matcher applies the
  // unified Q1 rule: explicit sessionId !== scope.sessionId triggers a
  // one-shot fetch; otherwise the scope cassette is used. (The dispatch was
  // previously asymmetric with execute() — see code review I1.)
  return (async function* () {
    const { currentScope } = await import("./replay/scope.js");
    const { ScopeMode } = await import("./replay/state.js");
    const scope = currentScope();
    if (scope?.mode === ScopeMode.REPLAY) {
      const { matchEvents } = await import("./replay/matcher.js");
      // steps() — filter: yield only step_completed events from reconstruction.
      for await (const evt of matchEvents(scope, flow._transport, flow.org, flow.project, flow.slug, opts as Record<string, unknown>)) {
        if (evt.type === "step_completed") {
          yield evt;
        }
      }
      return;
    }
    // Live path: drive the SSE protocol.
    yield* new EventIterator(flow, { ...opts, yieldOnlyStepCompleted: true });
  })();
}

/** @internal */
export function makeEventsIterator(
  flow: Flow,
  opts: EventsOptions,
): AsyncIterable<StreamEvent> {
  // In REPLAY mode, always delegate to the matcher (see makeStepsIterator
  // for the unified-rule rationale).
  return (async function* () {
    const { currentScope } = await import("./replay/scope.js");
    const { ScopeMode } = await import("./replay/state.js");
    const scope = currentScope();
    if (scope?.mode === ScopeMode.REPLAY) {
      const { matchEvents } = await import("./replay/matcher.js");
      yield* matchEvents(scope, flow._transport, flow.org, flow.project, flow.slug, opts as Record<string, unknown>);
      return;
    }
    // Live path: drive the SSE protocol.
    yield* new EventIterator(flow, { ...opts, yieldOnlyStepCompleted: false });
  })();
}
