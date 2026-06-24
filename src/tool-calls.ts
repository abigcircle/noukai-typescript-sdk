/**
 * Tool-call resume helpers.
 *
 * Provides two entry points:
 *   - `attachResume(paused, flow, captured)` — attaches a `.resume()` method to
 *     a PausedResult so the caller can manually drive one round-trip at a time.
 *   - `autoResumeLoop(paused, handler, maxRounds)` — drives the loop automatically
 *     by invoking the supplied handler for each round until a terminal result
 *     or the client-side round limit is reached.
 */

import type { ExecuteRequest } from "./types/requests.js";
import type { ExecuteResult, PausedResult } from "./types/responses.js";
import type { ToolHandler, VersionSpec } from "./flow.js";
import type { Transport } from "./transport.js";
import { ToolCallLimitError } from "./errors.js";
import { DEFAULT_MAX_TOOL_ROUNDS } from "./constants.js";
import { flowExecutePath } from "./paths.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Options captured at the time of the original `Flow.execute()` call so that
 * `.resume()` can rebuild the request without the caller needing to re-supply
 * them.
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
  version: VersionSpec;
  timeout?: number;
}

/**
 * Minimal shape we need from Flow without exposing private fields.
 * We access these via a cast in `attachResume`; the `/** @internal *\/` tag
 * on the Flow getters documents that they are not part of the public API.
 *
 * @internal
 */
interface FlowInternal {
  _transport: Transport;
  org: string;
  project: string;
  slug: string;
  _pathVersion(v: VersionSpec): "draft" | number;
}

// ---------------------------------------------------------------------------
// attachResume
// ---------------------------------------------------------------------------

/**
 * Attaches a `.resume()` method to `paused` in-place and returns it.
 *
 * The method is assigned via `Object.defineProperty` with `enumerable: false`
 * so that `JSON.stringify(paused)` does not attempt to serialize the function.
 *
 * @internal
 */
export function attachResume(
  paused: PausedResult,
  flow: FlowInternal,
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

    const url = flowExecutePath(
      flow.org,
      flow.project,
      flow.slug,
      flow._pathVersion(captured.version),
    );
    const resp = await flow._transport.request<Record<string, unknown>>("POST", url, {
      json: req,
      ...(captured.timeout !== undefined ? { timeout: captured.timeout } : {}),
    });

    const body = resp.body ?? {};

    if (body.status === "tool_calls_required") {
      const nextPaused = body as unknown as PausedResult;
      Object.defineProperty(nextPaused, "requiresToolCalls", {
        value: true,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      return attachResume(nextPaused, flow, captured);
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
// autoResumeLoop
// ---------------------------------------------------------------------------

/**
 * Drives the tool-call loop automatically by invoking `handler` for each
 * `PausedResult` until a terminal `ExecuteResult` is returned or `maxRounds`
 * is exceeded.
 *
 * Accepts both sync and async handlers via `Promise.resolve(handler(...))`.
 *
 * @throws {ToolCallLimitError} when `rounds >= maxRounds` before a terminal
 *   result is received (client-side limit).
 * @throws {FlowExecutionError} when the server returns 409 TOOL_ITERATION_LIMIT.
 *
 * @internal
 */
export async function autoResumeLoop(
  paused: PausedResult,
  handler: ToolHandler,
  maxRounds: number,
): Promise<ExecuteResult> {
  const limit = maxRounds > 0 ? maxRounds : DEFAULT_MAX_TOOL_ROUNDS;
  let current: ExecuteResult | PausedResult = paused;
  let rounds = 0;

  while (current.requiresToolCalls) {
    if (rounds >= limit) {
      throw new ToolCallLimitError(
        "Tool call loop exceeded maxToolRounds=" + String(limit),
        {
          code: "TOOL_CALL_LIMIT_CLIENT",
          executionId: current.executionId,
        },
      );
    }

    const toolResults = await Promise.resolve(
      handler(current.toolCalls),
    );
    current = await current.resume({ toolResults });
    rounds++;
  }

  return current;
}
