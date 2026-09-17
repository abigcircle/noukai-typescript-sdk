import type { ExecuteResult, PausedResult, JobAccepted } from "./types/responses.js";
import type { ChatMessage, ExecuteRequest } from "./types/requests.js";
import type { StepCompleted, StreamEvent } from "./types/events.js";
import type { Transport } from "./transport.js";
import type { FlowSpan } from "./otel.js";
import { Run } from "./run.js";
import { Job } from "./job.js";
import {
  DirectExecuteTransport,
  attachResume,
  autoResumeLoop,
  checkMessagesPayloadSize,
  validateFreshCall,
} from "./tool-calls.js";
import { makeStepsIterator, makeEventsIterator } from "./step-iterator.js";
import { DEFAULT_MAX_TOOL_ROUNDS, HEADER_SESSION_ID } from "./constants.js";
import { flowExecutePath, flowJobsSubmitPath } from "./paths.js";

export type VersionSpec = "draft" | "production" | number;

export type ToolHandler = (
  toolCalls: Record<string, unknown>[],
) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;

export interface ExecuteOptions {
  message?: string;
  /**
   * Structured prior conversation for chat/agent flows; the last entry is the
   * current user turn. Mutually exclusive with `message`. Roles must be
   * `user`/`assistant`/`tool` (validated client-side).
   */
  messages?: ChatMessage[];
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
   * Coerces the public `VersionSpec` ("draft" | "production" | number) into the
   * wire-level `VersionSegment` (`"production" | number`) that the `paths.ts`
   * helpers render into a URL. The server routes versions by path:
   *   - `"production"` → base path (production; draft/live fallback if unpublished)
   *   - `"draft"`      → `0`  (→ `/v0`, the reserved draft alias)
   *   - `<int>` (≥0)   → that integer (→ `/vN`)
   * See design 20260917-SDK-version-production-routing.
   */
  public _pathVersion(version: VersionSpec): "production" | number {
    if (typeof version === "number") {
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(
          `Invalid version: ${String(version)}. Pass a non-negative integer ` +
            `(0 = draft, N = published version), "draft", or "production".`,
        );
      }
      return version;
    }
    // Widen to `string` so the runtime guard below still protects untyped (JS)
    // callers who pass an unrecognised string, without tripping the type
    // narrowing lint (comparison-always-true).
    const v: string = version;
    if (v === "draft") return 0;
    if (v === "production") return "production";
    throw new Error(
      `Invalid version: ${JSON.stringify(version)}. ` +
        `Expected "draft", "production", or a non-negative integer.`,
    );
  }

  /**
   * @internal Reject the draft version for the step-through (SSE) endpoints.
   * The server returns `400 INVALID_VERSION` for `/v0/step` — draft is not
   * supported for step-through — so we fail fast with a clear message instead
   * of a confusing round-trip. `"draft"` and the equivalent integer `0` both
   * map to the `/v0` segment.
   */
  private assertStreamableVersion(version: VersionSpec): void {
    if (this._pathVersion(version) === 0) {
      throw new Error(
        "steps()/events() cannot run the draft version: the server does not " +
          "support step-through on draft (v0). Publish a version and pass " +
          "version: <N>, or use the default 'production'.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Execute (synchronous / in-process)
  // ---------------------------------------------------------------------------

  /**
   * Synchronous in-process flow execution.
   *
   * @param options.version - Version to execute. Omit (or pass `"production"`)
   *   to run the flow's production version (the server falls back to the live
   *   draft when the flow has no published version). Pass `"draft"` to force the
   *   live working copy, or an integer to pin to a specific published version.
   */
  async execute(options: ExecuteOptions = {}): Promise<ExecuteResult | PausedResult> {
    const version = options.version ?? "production";

    // Client-side validation of the server's fresh-call contract (F6).
    validateFreshCall(options.message, options.messages);
    checkMessagesPayloadSize(options.messages);

    // Opt-in OTel parent CLIENT span (a no-op unless the client set otel:true).
    // executionId/status are read off the resolved result, so every return path
    // (replay, paused, auto-resumed, normal) is covered.
    return this.__transport.spanFactory.flowSpan(
      "execute",
      { org: this.org, project: this.project, slug: this.slug, version: String(version) },
      async (span) => {
        const result = await this.executeImpl(options, version);
        await this.tagFlowSpan(span, result);
        return result;
      },
    );
  }

  /** @internal Body of {@link execute}, wrapped by the opt-in OTel span. */
  private async executeImpl(
    options: ExecuteOptions,
    version: VersionSpec,
  ): Promise<ExecuteResult | PausedResult> {
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
      ...(options.messages !== undefined && options.messages.length > 0
        ? { messages: options.messages }
        : {}),
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
      // Route resume through the execute-transport seam (the direct transport
      // preserves today's key-holding behavior byte-for-byte).
      attachResume(paused, new DirectExecuteTransport(this, version, options.timeout), {
        ...(options.parameters !== undefined ? { parameters: options.parameters } : {}),
        ...(options.blockOverrides !== undefined ? { blockOverrides: options.blockOverrides } : {}),
        ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        ...(options.trace !== undefined ? { trace: options.trace } : {}),
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
   * @param options.version - Version to execute. Omit (or pass `"production"`)
   *   to run the flow's production version. Pass `"draft"` to force the live
   *   working copy, or an integer to pin to a specific published version.
   */
  async executeAsync(options: ExecuteAsyncOptions = {}): Promise<Job> {
    const version = options.version ?? "production";

    // Opt-in OTel parent CLIENT span (a no-op unless the client set otel:true).
    return this.__transport.spanFactory.flowSpan(
      "execute_async",
      { org: this.org, project: this.project, slug: this.slug, version: String(version) },
      async (span) => {
        const result = await this.executeAsyncImpl(options, version);
        await this.tagFlowSpan(span, result);
        return result;
      },
    );
  }

  /** @internal Body of {@link executeAsync}, wrapped by the opt-in OTel span. */
  private async executeAsyncImpl(options: ExecuteAsyncOptions, version: VersionSpec): Promise<Job> {
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
   *
   * Defaults to the production version. `version:"draft"` (or `version:0`) is
   * rejected — the server does not support step-through on draft.
   */
  steps(options: StepsOptions = {}): AsyncIterable<StepCompleted> {
    this.assertStreamableVersion(options.version ?? "production");
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
   *
   * Defaults to the production version. `version:"draft"` (or `version:0`) is
   * rejected — the server does not support step-through on draft.
   */
  events(options: EventsOptions = {}): AsyncIterable<StreamEvent> {
    this.assertStreamableVersion(options.version ?? "production");
    return makeEventsIterator(this, options);
  }

  // ---------------------------------------------------------------------------
  // Phase 7 — not yet implemented
  // ---------------------------------------------------------------------------

  /**
   * @internal Tag the call span from the result, and — when `otelSteps` is on
   * and the run completed — fetch its trace and emit one child span per block.
   * The trace fetch is best-effort: a failure must never break the user's call.
   */
  private async tagFlowSpan(span: FlowSpan, result: unknown): Promise<void> {
    const rec = (result ?? {}) as Record<string, unknown>;
    const executionId = typeof rec.executionId === "string" ? rec.executionId : undefined;
    const status = typeof rec.status === "string" ? rec.status : undefined;
    span.setExecutionId(executionId);
    span.setStatus(status);
    if (
      this.__transport.spanFactory.stepSpansEnabled &&
      executionId !== undefined &&
      (status === "completed" || status === "failed")
    ) {
      try {
        const trace = await this.run(executionId).trace();
        span.emitStepSpans(trace.steps);
      } catch {
        // best-effort — a trace-fetch failure must never break the call
      }
    }
  }

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
