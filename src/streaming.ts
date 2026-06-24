/**
 * Pure SSE byte-stream parser.
 *
 * Consumes an `AsyncIterable<Uint8Array>` (typically `Transport.stream()`'s
 * output) and yields typed `StreamEvent`s. No knowledge of cursors, tool calls,
 * or transport — this is a pure transformation.
 *
 * Wire format: each frame carries the event type in the SSE-spec `event:`
 * field and the body in one or more `data:` lines:
 *
 *   event: step_completed
 *   data: {"stepId": "s-1", ...}
 *
 * Discriminator resolution: `event:` line wins; falls back to `eventType`
 * inside the JSON payload if `event:` is absent (back-compat).
 *
 * Algorithm:
 *  - Buffer bytes via `TextDecoder({ stream: true })` until `\n\n` is seen.
 *  - For each frame, capture the `event:` field and concatenate `data:`
 *    lines with `\n` (ignoring `:` comments and `id:`/`retry:`).
 *  - JSON-parse the body. Resolve the discriminator (event field → payload
 *    eventType fallback), look up in the known set, remap to SDK `type`.
 *  - Skip silently on unknown event types or malformed JSON (forward-compat).
 */

import type { StreamEvent } from "./types/events.js";

const KNOWN_EVENT_TYPES = new Set([
  "run_started",
  "flow_started",
  "step_started",
  "step_input",
  "step_output",
  "step_completed",
  "step_error",
  "step_paused",
  "step_paused_for_tool_calls",
  "flow_completed",
]);

/**
 * Map server wire `eventType` → SDK `type` discriminator.
 *
 * Most events map 1:1. The two exceptions:
 *  - `step_paused_for_tool_calls` → `tool_calls_required` (shorter, symmetric
 *    with the Python SDK class name).
 *  - `flow_started` → `run_started` (legacy alias — see noukai-server
 *    seqflow CONTEXT.md gotcha #10).
 */
const TYPE_REMAP: Record<string, string> = {
  step_paused_for_tool_calls: "tool_calls_required",
  flow_started: "run_started",
};

/**
 * Async generator that consumes a stream of `Uint8Array` chunks and yields
 * parsed `StreamEvent`s in order.
 *
 * Frame boundaries are reassembled across chunks (handles SSE frames split
 * mid-byte or that span multiple TCP packets). Multi-byte UTF-8 characters
 * split across chunks are handled by `TextDecoder({ stream: true })`.
 */
export async function* parseSSEStream(
  byteStream: AsyncIterable<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });

    // Drain all complete frames currently in the buffer.
    let sepIdx = buffer.indexOf("\n\n");
    while (sepIdx !== -1) {
      const frame = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const event = parseFrame(frame);
      if (event !== null) yield event;
      sepIdx = buffer.indexOf("\n\n");
    }
  }
  // Flush remaining decoder state. (We deliberately do NOT parse a trailing
  // partial frame — SSE requires `\n\n` to terminate a frame.)
  buffer += decoder.decode();
}

/**
 * Parse a single SSE frame (everything between two `\n\n` separators).
 *
 * Discriminator resolution order:
 *  1. SSE `event:` field (authoritative per spec).
 *  2. Payload `eventType` (back-compat fallback).
 *
 * Returns `null` for:
 *  - frames with no `data:` lines
 *  - malformed JSON
 *  - unknown event type (forward-compat: silently skip)
 *  - no resolvable discriminator
 */
function parseFrame(frame: string): StreamEvent | null {
  let eventField: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      // Per SSE spec, the data field is everything after `data:`, with a
      // single optional leading space stripped. We trimStart() for robustness.
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith("event:")) {
      eventField = line.slice(6).trimStart();
    }
    // Other field types (id:, retry:) are ignored.
  }
  if (dataLines.length === 0) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const wireType =
    eventField ??
    (typeof payload.eventType === "string" ? payload.eventType : undefined);
  if (typeof wireType !== "string" || !KNOWN_EVENT_TYPES.has(wireType)) return null;

  const sdkType = TYPE_REMAP[wireType] ?? wireType;
  // Strip `eventType` from payload, replace with `type` discriminator.
  // Build a shallow copy without the wire field rather than destructuring,
  // to avoid an `any` discard binding under the project's lint config.
  const out: Record<string, unknown> = { type: sdkType };
  for (const k of Object.keys(payload)) {
    if (k === "eventType") continue;
    out[k] = payload[k];
  }
  return out as unknown as StreamEvent;
}
