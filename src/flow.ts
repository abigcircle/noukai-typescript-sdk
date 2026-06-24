import type { ExecuteResult, PausedResult, JobAccepted } from "./types/responses.js";
import type { ExecuteRequest } from "./types/requests.js";
import type { StepCompleted, StreamEvent } from "./types/events.js";
import type { Transport } from "./transport.js";
import { Run } from "./run.js";
import { Job } from "./job.js";
import { attachResume, autoResumeLoop } from "./tool-calls.js";
import { makeStepsIterator, makeEventsIterator } from "./step-iterator.js";
import { DEFAULT_MAX_TOOL_ROUNDS, HEADER_SESSION_ID } from "./constants.js";
import { flowExecutePath, flowJobsSubmitPath } from "./paths.js";

export type VersionSpec = "draft" | "production" | number;

export type ToolHandler = (
  toolCalls: Record<string, unknown>[],
) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;

export interface ExecuteOptions {
  message?: string;
  parameters?: Record<string, unknown>;
  blockOverrides?: Record<string, Record<string, unknown>>;
  attachments?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  toolChoice?: unknown;
  toolHandler?: ToolHandler;
  maxToolRounds?: number;
  trace?: boolean;
  version?: VersionSpec;
  timeout?: number;
  signal?: AbortSignal;
  /** Override the AsyncLocalStorage/contextvar session id for this call only. */
  sessionId?: string; // NEW — Phase 2
}

export interface ExecuteAsyncOptions {
  message?: string;
  parameters?: Record<string, unknown>;
  blockOverrides?: Record<string, Record<string, unknown>>;
  trace?: boolean;
  version?: VersionSpec;
  timeout?: number;
  signal?: AbortSignal;
  /** Override the AsyncLocalStorage/contextvar session id for this call only. */
  sessionId?: string; // NEW — Phase 2
}

export interface StepsOptions extends Omit<ExecuteOptions, "attachments"> {
  inputOverrides?: Record<string, unknown>;
}

export interface EventsOptions extends StepsOptions {
  runRemaining?: boolean;
}

// ---------------------------------------------------------------------------
// Flow class
// ---------------------------------------------------------------------------

export class Flow {
  readonly org: string;
  readonly project: string;
  readonly slug: string;
  /** @internal — backing field; access via `_transport` getter. */
  private readonly __transport: Transport;

  constructor(options: {
    transport: Transport;
    org: string;
    project: string;
    slug: string;
  }) {
    this.__transport = options.transport;
    this.org = options.org;
    this.project = options.project;
    this.slug = options.slug;
  }

  // ---------------------------------------------------------------------------
  // Internal accessors (for tool-calls.ts only — not part of the public API)
  // ---------------------------------------------------------------------------

  /**
   * @internal Exposed for tool-calls.ts resume logic only.
   * Not part of the public API — do not use in application code.
   */
  public get _transport(): Transport {
    return this.__transport;
  }

  /**
   * @internal Exposed for tool-calls.ts and step-iterator.ts resume logic.
   * Not part of the public API — do not use in application code.
   *
   * Returns the `VersionSegment` form expected by helpers in `paths.ts`.
   * Coerces the public `VersionSpec` ("draft" | "production" | number) into
   * the wire-level shape (`"draft" | number`); `"production"` should be
   * rejected at the call site before reaching this method.
   */
  public _pathVersion(version: VersionSpec): "draft" | number {
    return typeof version === "number" ? version : "draft";
  }

  // ---------------------------------------------------------------------------
  // Execute (synchronous / in-process)
  // ---------------------------------------------------------------------------

  /**
   * Synchronous in-process flow execution.
   *
   * @param options.version - Version to execute. Omit (or pass `"draft"`) for
   *   the draft version. Pass an integer to pin to a specific published version.
   *   `"production"` will be supported in a future release once the server-side
   *   body-field routing is deployed — for now it raises an error.
   */
  async execute(options: ExecuteOptions = {}): Promise<ExecuteResult | PausedResult> {
    const version = options.version ?? "draft";

    if (version === "production") {
      throw new Error(
        "Flow.execute({version: 'production'}) is not yet supported. " +
        "Pin to an integer version (e.g. version: 3) or use the default 'draft'. " +
        "See https://github.com/noukai/noukai-node/issues/... for the server-side tracker.",
      );
    }

    // --- Phase 4: scope + session-id precedence ---
    const { currentScope } = await import("./replay/scope.js");
    const { ScopeMode } = await import("./replay/state.js");

    const scope = currentScope();

    // Precedence: per-call option > client default > contextvar scope
    const effectiveSid =
      options.sessionId ??
      this.__transport.defaultSessionId ??
      scope?.sessionId ??
      null;

    // REPLAY dispatch — unified rule across execute / steps / events:
    //   - No explicit sessionId, OR sessionId === scope.sessionId → match
    //     against the scope cassette (slug-positional).
    //   - Explicit sessionId !== scope.sessionId → matcher performs a
    //     one-shot fetch of that session.
    // matchExecute() handles both branches internally.
    if (scope?.mode === ScopeMode.REPLAY) {
      const { matchExecute } = await import("./replay/matcher.js");
      return await matchExecute(scope, this.__transport, this.org, this.project, this.slug, options as Record<string, unknown>);
    }

    // Build request using conditional spreads to satisfy exactOptionalPropertyTypes.
    const req: ExecuteRequest = {
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.parameters !== undefined ? { parameters: options.parameters } : {}),
      ...(options.blockOverrides !== undefined ? { blockOverrides: options.blockOverrides } : {}),
      ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
      trace: options.trace ?? false,
    };

    // CAPTURE / NORMAL: inject X-Session-Id header when a session id is active
    const extraHeaders: Record<string, string> = {};
    if (effectiveSid !== null) {
      extraHeaders[HEADER_SESSION_ID] = effectiveSid;
    }

    const url = flowExecutePath(this.org, this.project, this.slug, this._pathVersion(version));
    const resp = await this.__transport.request<Record<string, unknown>>("POST", url, {
      json: req,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    });

    const body = resp.body ?? {};

    if (body.status === "tool_calls_required") {
      const paused = body as unknown as PausedResult;
      // Use Object.defineProperty because TS marks requiresToolCalls as readonly true.
      Object.defineProperty(paused, "requiresToolCalls", {
        value: true,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      // Phase 5 (R1): surface sessionId on PausedResult so callers can read it
      // after scope exit without needing currentSessionId().
      if (effectiveSid !== null) {
        (paused as { sessionId?: string }).sessionId = effectiveSid;
      }
      attachResume(paused, this, {
        ...(options.parameters !== undefined ? { parameters: options.parameters } : {}),
        ...(options.blockOverrides !== undefined ? { blockOverrides: options.blockOverrides } : {}),
        ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        ...(options.trace !== undefined ? { trace: options.trace } : {}),
        version,
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      });
      if (options.toolHandler !== undefined) {
        return await autoResumeLoop(
          paused,
          options.toolHandler,
          options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
        );
      }
      return paused;
    }

    const result = body as unknown as ExecuteResult;
    Object.defineProperty(result, "requiresToolCalls", {
      value: false,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    // Phase 5 (R1): surface sessionId on ExecuteResult so callers can read it
    // after scope exit without needing currentSessionId().
    if (effectiveSid !== null) {
      result.sessionId = effectiveSid;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // ExecuteAsync (queue-backed)
  // ---------------------------------------------------------------------------

  /**
   * Submit async (queue-backed) execution. Returns a Job handle.
   *
   * @param options.version - Version to execute. Omit (or pass `"draft"`) for
   *   the draft version. Pass an integer to pin to a specific published version.
   *   `"production"` will be supported in a future release.
   */
  async executeAsync(options: ExecuteAsyncOptions = {}): Promise<Job> {
    const version = options.version ?? "draft";

    if (version === "production") {
      throw new Error(
        "Flow.executeAsync({version: 'production'}) is not yet supported. " +
        "Pin to an integer version (e.g. version: 3) or use the default 'draft'. " +
        "See https://github.com/noukai/noukai-node/issues/... for the server-side tracker.",
      );
    }

    // --- Phase 4: scope + session-id precedence ---
    const { currentScope } = await import("./replay/scope.js");
    const { ScopeMode: ScopeModeAsync } = await import("./replay/state.js");
    const scope = currentScope();

    // R10: executeAsync is not supported in replay v1.
    if (scope?.mode === ScopeModeAsync.REPLAY) {
      const { replayExecuteAsyncNotSupported } = await import("./replay/matcher.js");
      replayExecuteAsyncNotSupported();
    }

    const effectiveSid =
      options.sessionId ??
      this.__transport.defaultSessionId ??
      scope?.sessionId ??
      null;

    // Build request using conditional spreads to satisfy exactOptionalPropertyTypes.
    const req: ExecuteRequest = {
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.parameters !== undefined ? { parameters: options.parameters } : {}),
      ...(options.blockOverrides !== undefined ? { blockOverrides: options.blockOverrides } : {}),
      trace: options.trace ?? false,
    };

    const extraHeaders: Record<string, string> = {};
    if (effectiveSid !== null) {
      extraHeaders[HEADER_SESSION_ID] = effectiveSid;
    }

    const url = flowJobsSubmitPath(this.org, this.project, this.slug, this._pathVersion(version));
    const resp = await this.__transport.request<JobAccepted>("POST", url, {
      json: req,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    });

    if (resp.body === null) {
      throw new Error("executeAsync: server returned empty response body");
    }
    const accepted = resp.body;
    // Phase 5 (R1): surface sessionId on the JobAccepted body so callers can
    // correlate the async job with the capture session.
    if (effectiveSid !== null) {
      accepted.sessionId = effectiveSid;
    }
    return new Job({
      transport: this.__transport,
      org: this.org,
      project: this.project,
      slug: this.slug,
      executionId: accepted.executionId,
      flowId: accepted.flowId,
    });
  }

  // ---------------------------------------------------------------------------
  // Step-by-step streaming (SSE)
  // ---------------------------------------------------------------------------

  /**
   * Async iterable yielding one `StepCompleted` per finished step.
   *
   * Drives `POST /seq/.../step` calls internally, threading the cursor
   * (`executionId`, `accumulatedOutputs`) across requests. Filters out
   * intermediate events (`step_started`, `step_input`, `flow_completed`, etc.)
   * — use `events()` if you want the full stream.
   *
   * Note: `steps()` does NOT accept `runRemaining` (that's `events()` only).
   */
  steps(options: StepsOptions = {}): AsyncIterable<StepCompleted> {
    return makeStepsIterator(this, options) as AsyncIterable<StepCompleted>;
  }

  /**
   * Async iterable yielding every typed SSE event.
   *
   * Includes `RunStarted`, `StepStarted`, `StepInput`, `StepOutput`,
   * `StepCompleted`, `StepFailed`, `StepPaused`, `ToolCallsRequired`, and
   * `FlowCompleted`. If a `ToolCallsRequired` event surfaces (no
   * `toolHandler` set), call `await event.resume({toolResults})` to continue
   * the iteration with tool results.
   *
   * Set `runRemaining: true` to ask the server to execute all remaining
   * steps in a single SSE stream rather than pausing between steps.
   */
  events(options: EventsOptions = {}): AsyncIterable<StreamEvent> {
    return makeEventsIterator(this, options);
  }

  // ---------------------------------------------------------------------------
  // Phase 7 — not yet implemented
  // ---------------------------------------------------------------------------

  /** Build a Run proxy for trace operations on a known executionId. */
  run(executionId: string): Run {
    return new Run({
      transport: this._transport,
      org: this.org,
      project: this.project,
      slug: this.slug,
      executionId,
    });
  }
}
