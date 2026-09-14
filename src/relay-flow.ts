/**
 * Keyless relay flow entrypoint (design 20260903-SDK-agent-relay, PR-2).
 *
 * `createRelayFlow({ url, fetch? })` / `RelayFlow` run the same yield/resume
 * tool-calling loop as `flow.execute()` — but over a keyless
 * {@link RelayExecuteTransport} pointed at a relay URL (no `nk_` key, no `/seq`
 * path). This is the browser / server-to-server / CLI agent entrypoint: the
 * loop drives the round-trips and executes tools locally; a keyholder relay
 * forwards each request to the flow's `/execute`.
 *
 * Both fresh-call modes are supported — a single `message` (Nana style) and a
 * structured `messages` list (Pack Maker / agent-block style). The client-side
 * round limit is the SDK's `DEFAULT_MAX_TOOL_ROUNDS` (10), reconciling the two
 * historical limits (SDK 10 vs `@noukai/agent` 12) onto one value.
 */

import type { ChatMessage, ExecuteRequest } from "./types/requests.js";
import type { ExecuteResult, PausedResult } from "./types/responses.js";
import type { ToolHandler } from "./flow.js";
import { DEFAULT_MAX_TOOL_ROUNDS } from "./constants.js";
import {
  RelayExecuteTransport,
  type CapturedOptions,
  checkMessagesPayloadSize,
  runExecute,
  validateFreshCall,
} from "./tool-calls.js";

export interface CreateRelayFlowOptions {
  /** The relay endpoint the loop POSTs to, keyless. */
  url: string;
  /** Optional custom `fetch` (custom runtime / tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Per-request timeout in **seconds** (parity with the Python peer). Bounds each
   * relay round-trip so a hung relay can't stall the loop forever. `undefined`
   * uses the SDK default (300 s). Combined with any per-call `signal`.
   */
  timeout?: number;
}

export interface RelayExecuteOptions {
  message?: string;
  messages?: ChatMessage[];
  parameters?: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  toolChoice?: unknown;
  toolHandler?: ToolHandler;
  maxToolRounds?: number;
  trace?: boolean;
  signal?: AbortSignal;
}

export class RelayFlow {
  constructor(private readonly options: CreateRelayFlowOptions) {}

  /**
   * Run the loop over the relay. Resolves to an `ExecuteResult` on completion,
   * or a `PausedResult` when `toolHandler` is omitted and the flow paused for
   * tools (drive it with `await paused.resume({ toolResults })`).
   */
  async execute(opts: RelayExecuteOptions = {}): Promise<ExecuteResult | PausedResult> {
    validateFreshCall(opts.message, opts.messages);
    checkMessagesPayloadSize(opts.messages);

    const req: ExecuteRequest = {
      ...(opts.message !== undefined ? { message: opts.message } : {}),
      ...(opts.messages !== undefined && opts.messages.length > 0
        ? { messages: opts.messages }
        : {}),
      ...(opts.parameters !== undefined ? { parameters: opts.parameters } : {}),
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.toolChoice !== undefined ? { toolChoice: opts.toolChoice } : {}),
      trace: opts.trace ?? false,
    };

    const transport = new RelayExecuteTransport({
      url: this.options.url,
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeout !== undefined ? { timeout: this.options.timeout } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const captured: CapturedOptions = {
      ...(opts.parameters !== undefined ? { parameters: opts.parameters } : {}),
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.toolChoice !== undefined ? { toolChoice: opts.toolChoice } : {}),
      ...(opts.trace !== undefined ? { trace: opts.trace } : {}),
    };

    return runExecute(
      transport,
      req,
      captured,
      opts.toolHandler,
      opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    );
  }
}

/** Build a {@link RelayFlow} for a keyless relay endpoint. */
export function createRelayFlow(options: CreateRelayFlowOptions): RelayFlow {
  return new RelayFlow(options);
}
