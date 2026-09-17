/**
 * Tool-call loop + execute-transport seam (design 20260903-SDK-agent-relay).
 *
 * The yield/resume tool-calling loop is written once and made
 * transport-pluggable via the {@link ExecuteTransport} seam, so it runs in two
 * positions against one wire contract:
 *   - direct  — `flow.execute()` over a {@link DirectExecuteTransport} (today's
 *     key-holding behavior, unchanged).
 *   - relay   — `createRelayFlow()` over a {@link RelayExecuteTransport} that
 *     POSTs the raw payload to a keyless relay URL.
 *
 * `send(payload) -> { status, body }` is the only thing that varies. The direct
 * transport throws typed errors on non-2xx (so `send` returns only on 2xx); the
 * relay transport returns the upstream status verbatim and the shared driver
 * maps a non-2xx to the same typed-error taxonomy.
 */

import type { ChatMessage, ExecuteRequest } from "./types/requests.js";
import type { ExecuteResult, PausedResult } from "./types/responses.js";
import type { ToolHandler, VersionSpec } from "./flow.js";
import type { Transport } from "./transport.js";
import { errorForExecuteStatus } from "./transport.js";
import { ToolCallLimitError } from "./errors.js";
import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_TIMEOUT_MS } from "./constants.js";
import { flowExecutePath } from "./paths.js";

/** 1 MB — mirrors the server's MAX_MESSAGES_PAYLOAD_BYTES (413 MESSAGES_TOO_LARGE). */
export const MESSAGES_PAYLOAD_SOFT_LIMIT_BYTES = 1_000_000;
const ALLOWED_MESSAGE_ROLES = new Set(["user", "assistant", "tool"]);

// ---------------------------------------------------------------------------
// Client-side validation of the server's fresh-call contract (surface early)
// ---------------------------------------------------------------------------

/**
 * Validate a fresh execute call against the server contract, client-side.
 * `message`/`messages` are mutually exclusive; `messages[]` may only carry
 * `user`/`assistant`/`tool` roles (a `system`/`function` turn would override
 * the flow author's system prompt — 400 MESSAGES_ROLE_INVALID).
 */
export function validateFreshCall(
  message: string | null | undefined,
  messages: ChatMessage[] | undefined,
): void {
  if (message != null && messages != null) {
    throw new Error(
      "execute(): provide either `message` or `messages`, not both (`messages` stands in for `message`).",
    );
  }
  if (messages != null) {
    messages.forEach((m, i) => {
      const role = typeof m.role === "string" ? m.role : undefined;
      if (role === undefined) {
        throw new Error(
          `messages[${String(i)}] is missing a string \`role\`. Each turn must carry a ` +
            `'user', 'assistant', or 'tool' role.`,
        );
      }
      if (!ALLOWED_MESSAGE_ROLES.has(role)) {
        throw new Error(
          `messages[${String(i)}].role='${role}' is not allowed. The server accepts only ` +
            `'user', 'assistant', or 'tool' — a caller 'system'/'function' turn would ` +
            `override the flow author's system prompt (MESSAGES_ROLE_INVALID).`,
        );
      }
    });
  }
}

/**
 * Warn (once per process) when a `messages` payload approaches the server's
 * 1 MB cap. Deduplicated so a loop of large-conversation calls doesn't spam the
 * console — parity with the Python peer, whose `warnings.warn` dedups per site.
 */
// Warns once per process (module-global). The Python peer's is effectively once
// per call-site via the default `warnings` filter — same "warn once" intent.
let hasWarnedMessagesSize = false;
export function checkMessagesPayloadSize(messages: ChatMessage[] | undefined): void {
  if (messages === undefined || messages.length === 0 || hasWarnedMessagesSize) return;
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(messages)).length;
  } catch {
    return;
  }
  if (size > MESSAGES_PAYLOAD_SOFT_LIMIT_BYTES * 0.9) {
    hasWarnedMessagesSize = true;
    console.warn(
      `[noukai] messages payload is ~${String(size)} bytes, approaching the server's ` +
        `${String(MESSAGES_PAYLOAD_SOFT_LIMIT_BYTES)}-byte cap (MESSAGES_TOO_LARGE). ` +
        `Consider compacting the conversation.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Captured resume options + the execute-transport seam
// ---------------------------------------------------------------------------

/**
 * Options captured at the original `execute()` call so `.resume()` can rebuild
 * the request. `version`/`timeout` are NOT here — they are captured by the
 * `DirectExecuteTransport` instead.
 *
 * @internal
 */
export interface CapturedOptions {
  parameters?: Record<string, unknown>;
  blockOverrides?: Record<string, Record<string, unknown>>;
  attachments?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  toolChoice?: unknown;
  trace?: boolean;
}

/**
 * Minimal shape we need from Flow without exposing private fields.
 * @internal
 */
export interface FlowInternal {
  _transport: Transport;
  org: string;
  project: string;
  slug: string;
  _pathVersion(v: VersionSpec): "production" | number;
}

/** The one step the loop routes through: send a payload, get back `(status, body)`. */
export interface ExecuteTransport {
  send(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}

/**
 * `ExecuteTransport` wrapping a flow's key-holding transport. Preserves today's
 * resume behavior byte-for-byte (same `{versioned_path}/execute` URL + timeout;
 * the underlying transport throws typed errors on non-2xx).
 */
export class DirectExecuteTransport implements ExecuteTransport {
  constructor(
    private readonly flow: FlowInternal,
    private readonly version: VersionSpec,
    private readonly timeout?: number,
  ) {}

  async send(
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = flowExecutePath(
      this.flow.org,
      this.flow.project,
      this.flow.slug,
      this.flow._pathVersion(this.version),
    );
    const resp = await this.flow._transport.request<Record<string, unknown>>("POST", url, {
      json: payload,
      ...(this.timeout !== undefined ? { timeout: this.timeout } : {}),
    });
    return { status: resp.statusCode, body: resp.body ?? {} };
  }
}

/** Options for {@link RelayExecuteTransport} / {@link createRelayFlow}. */
export interface RelayExecuteTransportOptions {
  /** The relay endpoint the payload is POSTed to, keyless. */
  url: string;
  /** Optional custom `fetch` (custom runtime / tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
  /**
   * Per-request timeout in **seconds** (parity with the Python peer). A hung
   * relay must not stall the browser loop forever, so each POST is bounded by an
   * internal `AbortController`. `undefined` falls back to the SDK default
   * (`DEFAULT_TIMEOUT_MS`, 300 s). Combined with any caller `signal` — either can
   * abort the fetch.
   */
  timeout?: number;
}

/**
 * Combine a timeout signal with an optional caller signal so EITHER aborts the
 * fetch. Deliberately avoids `AbortSignal.any` — `engines` allows Node >=18,
 * where it may be absent (added in Node 20.3). Chains via a shared controller.
 */
function combineAbortSignals(
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): AbortSignal {
  if (callerSignal === undefined) return timeoutSignal;
  const controller = new AbortController();
  for (const src of [timeoutSignal, callerSignal]) {
    if (src.aborted) {
      controller.abort(src.reason);
      break;
    }
    src.addEventListener("abort", () => { controller.abort(src.reason); }, { once: true });
  }
  return controller.signal;
}

/**
 * Keyless `ExecuteTransport`: POST the raw payload to a relay URL. No `nk_` key,
 * no `/seq` path — the relay (a keyholder proxy) injects the key and pins the
 * flow. Returns the relay's `(status, body)` verbatim; the shared driver maps a
 * non-2xx to a typed error.
 */
export class RelayExecuteTransport implements ExecuteTransport {
  constructor(private readonly options: RelayExecuteTransportOptions) {}

  async send(
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const doFetch = this.options.fetch ?? fetch;
    // Bound the round-trip so a hung relay can't stall the loop forever.
    // `timeout` is seconds (parity with Python); `undefined` → SDK default.
    const timeoutMs =
      this.options.timeout !== undefined ? this.options.timeout * 1000 : DEFAULT_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => { timeoutController.abort(); }, timeoutMs);
    const signal = combineAbortSignals(timeoutController.signal, this.options.signal);
    try {
      const resp = await doFetch(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      let body: unknown = null;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
      return {
        status: resp.status,
        body: body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {},
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

// ---------------------------------------------------------------------------
// attachResume (transport-parameterized)
// ---------------------------------------------------------------------------

/**
 * Attach a `.resume()` method to `paused` (in place, non-enumerable) driving
 * the loop through the given {@link ExecuteTransport}. Returns `paused`.
 *
 * @internal
 */
export function attachResume(
  paused: PausedResult,
  transport: ExecuteTransport,
  captured: CapturedOptions,
): PausedResult {
  const resumeFn = async ({
    toolResults,
  }: {
    toolResults: Record<string, unknown>[];
  }): Promise<ExecuteResult | PausedResult> => {
    const newMessages = [...paused.toolCallMessages, ...toolResults];

    const req: ExecuteRequest = {
      message: null,
      ...(captured.parameters !== undefined ? { parameters: captured.parameters } : {}),
      ...(captured.blockOverrides !== undefined ? { blockOverrides: captured.blockOverrides } : {}),
      ...(captured.attachments !== undefined ? { attachments: captured.attachments } : {}),
      ...(captured.tools !== undefined ? { tools: captured.tools } : {}),
      ...(captured.toolChoice !== undefined ? { toolChoice: captured.toolChoice } : {}),
      executionId: paused.executionId,
      pausedAtStep: paused.pausedAtStep,
      iterationsUsed: paused.iterationsUsed,
      toolCallMessages: newMessages,
      accumulatedOutputs: paused.accumulatedOutputs,
      trace: captured.trace ?? false,
    };

    const { status, body } = await transport.send(req as unknown as Record<string, unknown>);
    if (status < 200 || status >= 300) {
      throw errorForExecuteStatus(status, body);
    }

    if (body.status === "tool_calls_required") {
      const nextPaused = body as unknown as PausedResult;
      Object.defineProperty(nextPaused, "requiresToolCalls", {
        value: true,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      return attachResume(nextPaused, transport, captured);
    }

    const result = body as unknown as ExecuteResult;
    Object.defineProperty(result, "requiresToolCalls", {
      value: false,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    return result;
  };

  Object.defineProperty(paused, "resume", {
    value: resumeFn,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return paused;
}

// ---------------------------------------------------------------------------
// Shared fresh-call driver (used by createRelayFlow; flow.execute keeps its own
// session/replay-aware fresh call and only routes resume through the seam)
// ---------------------------------------------------------------------------

/** Run the fresh call + pause/resume loop over an {@link ExecuteTransport}. */
export async function runExecute(
  transport: ExecuteTransport,
  req: ExecuteRequest,
  captured: CapturedOptions,
  toolHandler: ToolHandler | undefined,
  maxRounds: number,
): Promise<ExecuteResult | PausedResult> {
  const { status, body } = await transport.send(req as unknown as Record<string, unknown>);
  if (status < 200 || status >= 300) {
    throw errorForExecuteStatus(status, body);
  }

  if (body.status === "tool_calls_required") {
    const paused = body as unknown as PausedResult;
    Object.defineProperty(paused, "requiresToolCalls", {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    attachResume(paused, transport, captured);
    if (toolHandler !== undefined) {
      return autoResumeLoop(paused, toolHandler, maxRounds);
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
  return result;
}

// ---------------------------------------------------------------------------
// autoResumeLoop (transport-agnostic — drives via paused.resume)
// ---------------------------------------------------------------------------

/**
 * Drive the tool-call loop automatically by invoking `handler` for each
 * `PausedResult` until a terminal `ExecuteResult` or `maxRounds` is exceeded.
 *
 * @throws {ToolCallLimitError} when `rounds >= maxRounds` before a terminal result.
 * @internal
 */
export async function autoResumeLoop(
  paused: PausedResult,
  handler: ToolHandler,
  maxRounds: number,
): Promise<ExecuteResult> {
  // Honor the caller's explicit bound verbatim — including 0 / negative, which
  // make the loop raise on the first pause (parity with the Python loop).
  // Omitted values are pre-defaulted to DEFAULT_MAX_TOOL_ROUNDS by the callers
  // (flow.execute / createRelayFlow / step-iterator), so a finite value here is
  // always an intentional caller choice; a non-finite value falls back.
  const limit = Number.isFinite(maxRounds) ? maxRounds : DEFAULT_MAX_TOOL_ROUNDS;
  let current: ExecuteResult | PausedResult = paused;
  let rounds = 0;

  while (current.requiresToolCalls) {
    if (rounds >= limit) {
      throw new ToolCallLimitError("Tool call loop exceeded maxToolRounds=" + String(limit), {
        code: "TOOL_CALL_LIMIT_CLIENT",
        executionId: current.executionId,
      });
    }

    const toolResults = await Promise.resolve(handler(current.toolCalls));
    current = await current.resume({ toolResults });
    rounds++;
  }

  return current;
}
