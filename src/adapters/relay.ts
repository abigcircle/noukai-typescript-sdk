/**
 * Flow relay core — framework-agnostic (design 20260903-SDK-agent-relay, PR-1).
 *
 * A *relay* is a keyholder proxy. It holds the `nk_` bearer, receives a keyless
 * POST from a browser (or another server), bounds abuse, runs an app-supplied
 * `authorize` hook, then forwards the request **verbatim** to the flow's
 * `/execute` endpoint and relays the upstream `(status, body)` back unchanged.
 * The browser drives the tool-calling loop and executes tools; the relay never
 * interprets the business payload.
 *
 * This module holds the shared logic (bounds + parse + verbatim forward). The
 * framework handlers live next to the existing replay adapters:
 *   - `noukaiRelayHandler` in `adapters/express.ts`
 *   - `createRelayRoute`   in `adapters/nextjs.ts`
 * mirroring the Python `adapters/relay.py` (one file, two framework variants).
 *
 * Security invariants (design § "What must NOT leak into the SDK"):
 *   - App authorization stays in the app — the `authorize` hook only.
 *   - Bound values (256 KiB / 40) are adapter config, never SDK-wide constants.
 *   - The relay never logs the key or the body.
 *   - The relay does not throw typed errors in place of relaying status — the
 *     forward uses `raiseForStatus: false` so upstream 4xx/5xx pass through.
 */

import type { Noukai } from "../client.js";
import { flowExecutePath, type VersionSegment } from "../paths.js";

export const DEFAULT_RELAY_PATH = "/agent/execute";
export const DEFAULT_MAX_BODY_BYTES = 262_144; // 256 KiB
export const DEFAULT_MAX_MESSAGES = 40;

/**
 * Abuse bounds enforced by the relay before forwarding. Adapter config — never
 * SDK-wide constants (design non-goal). `maxBodyBytes` is checked on the raw
 * request bytes *before* JSON parse; `maxMessages` caps each of the `messages`
 * / `toolCallMessages` arrays independently.
 */
export interface RelayBounds {
  maxBodyBytes?: number;
  maxMessages?: number;
}

/** Shared config identifying the single flow a relay is pinned to. */
export interface FlowRelayConfig {
  /** A `Noukai` client — its transport holds the `nk_` bearer injected on the forward. */
  client: Noukai;
  org: string;
  project: string;
  slug: string;
  bounds?: RelayBounds;
  /**
   * `"production"` (default) runs the flow's production version; `"draft"` runs
   * the live working copy; an integer pins a published version.
   */
  version?: "draft" | "production" | number;
}

/** The `(status, body)` a relay hands back — always JSON-serializable. */
export interface RelayOutcome {
  status: number;
  body: unknown;
}

/** A bounds/parse rejection: the HTTP status + generic detail to return. */
export interface RelayReject {
  status: number;
  detail: string;
}

/**
 * W3C trace-context headers a relay forwards so a browser-initiated distributed
 * trace continues onto the relay→Noukai hop. Lower-case canonical forms (HTTP
 * header names are case-insensitive). The browser agent SDK (`@noukai/agent`,
 * `otel: true`) injects `traceparent` on its POST; forwarding it here lets the
 * customer's trace span browser → relay → Noukai ingress in one tree.
 */
export const TRACE_CONTEXT_HEADERS = ["traceparent", "tracestate"] as const;

/**
 * Pull the W3C trace-context headers out of an incoming request via a
 * `getHeader(name)` accessor (name is lower-case), returning only those present
 * and non-empty. Framework-agnostic so both the Express and Next.js handlers
 * share one extraction rule. These are the ONLY inbound headers a relay forwards
 * — everything else about the request stays opaque to the relay.
 */
export function extractTraceHeaders(
  getHeader: (name: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TRACE_CONTEXT_HEADERS) {
    const v = getHeader(name);
    if (v !== undefined && v !== "") out[name] = v;
  }
  return out;
}

export function resolveBounds(bounds?: RelayBounds): Required<RelayBounds> {
  return {
    maxBodyBytes: bounds?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxMessages: bounds?.maxMessages ?? DEFAULT_MAX_MESSAGES,
  };
}

function normalizeRelayVersion(
  version: "draft" | "production" | number | undefined,
): VersionSegment {
  if (typeof version === "number") {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(
        `flow relay version must be "draft", "production", or a non-negative integer, got ${String(version)}`,
      );
    }
    return version;
  }
  // `undefined` defaults to the base (production) segment.
  if (version === undefined) return "production";
  // Widen to `string` so the runtime guard still protects untyped (JS) callers
  // who pass an unrecognised string, without tripping the type-narrowing lint.
  const v: string = version;
  // `"production"` → base path; `"draft"` → the reserved `/v0` alias (the relay
  // forwards to /execute, which supports draft).
  if (v === "production") return "production";
  if (v === "draft") return 0;
  // Any other string must NOT silently coerce and serve the wrong flow version —
  // mirror the Python adapter, which raises.
  throw new Error(
    `flow relay version must be "draft", "production", or a non-negative integer, got ${JSON.stringify(version)}`,
  );
}

/**
 * Bound already-read raw text, parse JSON, then bound message counts. Returns
 * either the parsed payload or the `(status, detail)` to reject with. The byte
 * bound runs before `JSON.parse` so we never decode an oversized body.
 */
export function boundAndParseBody(
  raw: string,
  bounds: Required<RelayBounds>,
): { payload: Record<string, unknown> } | { reject: RelayReject } {
  const byteLen = new TextEncoder().encode(raw).length;
  if (byteLen > bounds.maxBodyBytes) {
    return { reject: { status: 413, detail: "BODY_TOO_LARGE" } };
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return { reject: { status: 400, detail: "INVALID_JSON" } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reject: { status: 400, detail: "INVALID_JSON" } };
  }
  const payload = parsed as Record<string, unknown>;
  for (const key of ["messages", "toolCallMessages"] as const) {
    const v = payload[key];
    if (Array.isArray(v) && v.length > bounds.maxMessages) {
      return { reject: { status: 413, detail: "TOO_MANY_MESSAGES" } };
    }
  }
  return { payload };
}

/**
 * Forward a bounded payload verbatim to the pinned flow's `/execute` endpoint
 * with the `nk_` bearer injected (`raiseForStatus: false`), and relay the
 * upstream `(status, body)`. A non-object upstream body (a non-JSON string, or
 * `null`) is normalized to `{ detail: "UPSTREAM_NON_JSON" }` at the same status.
 */
export async function forwardToFlow(
  config: FlowRelayConfig,
  payload: Record<string, unknown>,
  traceHeaders?: Record<string, string>,
): Promise<RelayOutcome> {
  const seg = normalizeRelayVersion(config.version);
  const url = flowExecutePath(config.org, config.project, config.slug, seg);
  const resp = await config.client._transport.request("POST", url, {
    json: payload,
    raiseForStatus: false,
    // A relay forward is a non-idempotent POST — never silently re-submit it on
    // a transient upstream 5xx (parity with the Python relay). Relay the first
    // upstream status verbatim.
    idempotent: false,
    // Forward W3C trace context (only) so a browser-initiated trace continues to
    // Noukai. `traceparent`/`tracestate` are not reserved headers, so they pass
    // `applyExtraHeaders`; the bearer/version/request-id remain transport-managed.
    ...(traceHeaders !== undefined && Object.keys(traceHeaders).length > 0
      ? { extraHeaders: traceHeaders }
      : {}),
  });
  // NOTE (design item F5, deferred — needs backend): the upstream body is
  // relayed verbatim, so raw execution-state (`executionId`, `pausedAtStep`,
  // `iterationsUsed`, `toolCallMessages`, `accumulatedOutputs`) crosses back to
  // the untrusted browser and returns on the next resume. Replacing it with an
  // opaque, signed `stateToken` the relay mints/verifies is the deferred F5
  // design item. Do NOT "fix" this by stripping fields here — the browser needs
  // them to resume until the backend supports the token.
  const body = resp.body;
  if (body !== null && typeof body === "object") {
    return { status: resp.statusCode, body };
  }
  return { status: resp.statusCode, body: { detail: "UPSTREAM_NON_JSON" } };
}

/**
 * Map a thrown `authorize` error to a relay response.
 *
 * An error that carries a numeric `status`/`statusCode` is treated as an
 * INTENTIONAL rejection: that status is used, and a string `detail` (if the
 * hook set one) is surfaced to the client. Any other thrown value — including a
 * plain `Error`, `throw null`, or an unexpected bug — becomes a generic
 * `403 FORBIDDEN` and is NEVER allowed to reach the untrusted client. In
 * particular the thrown error's `.message` is never echoed (it may hold
 * internal detail); the hook must set an explicit `detail` to customize the
 * client-facing text. Auth failures fail closed. App authorization stays in the
 * app — the hook decides the status by throwing an error that carries one.
 */
export function authRejectionResponse(err: unknown): RelayReject {
  // `throw null` / non-object throws collapse to an empty object so the field
  // reads below stay total (and lint-clean — no optional chaining needed).
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    status?: unknown;
    statusCode?: unknown;
    detail?: unknown;
  };
  const hasHttpStatus = typeof e.status === "number" || typeof e.statusCode === "number";
  if (!hasHttpStatus) {
    return { status: 403, detail: "FORBIDDEN" };
  }
  const status = typeof e.status === "number" ? e.status : (e.statusCode as number);
  const detail = typeof e.detail === "string" ? e.detail : "FORBIDDEN";
  return { status, detail };
}
