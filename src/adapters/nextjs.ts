/**
 * Next.js App Router higher-order function adapter for the Noukai replay feature.
 *
 * Wraps a route handler function to read `X-Noukai-Replay` from the incoming
 * request, open a `replayScope` around the handler, and write `X-Noukai-Session`
 * on the returned Response in capture mode.
 *
 * Usage:
 *   import { withNoukaiTrace } from "@noukai/sdk/adapters/nextjs";
 *   export const POST = withNoukaiTrace(async (req) => {
 *     const result = await noukai.flow("a/b/c").execute({ message: req.body });
 *     return Response.json({ result });
 *   }, { client: noukai });
 *
 * Design decisions:
 *
 * **HOF instead of middleware (§ 8.5):** Next.js App Router does not have a
 * middleware pattern that wraps individual route handlers — `middleware.ts` runs
 * before the router, before the handler has access to the request body. The
 * canonical pattern for instrumenting route handlers is a higher-order function
 * wrapping the exported GET/POST/etc. handler. Pages Router users can apply the
 * same HOF pattern on `(req, res)` handlers.
 *
 * **Capture sid after scope runs (§ 8.5):** The session id is generated inside
 * `replayScope` before the handler body runs. We read it with `currentSessionId()`
 * from inside the scope body (so AsyncLocalStorage is still active), capture it
 * in a closure variable, and then apply it to the returned Response after the
 * handler completes.
 *
 * **Single client per HOF instance (Q8):** Same as the Express adapter.
 *
 * **Minimal types:** avoid a hard dep on the `next` package. The HOF uses
 * structural typing (`MinimalRequest`) compatible with both Next.js `Request`
 * (Web Fetch API) and Node.js `IncomingMessage`-based pages-router shapes.
 */

import type { Noukai } from "../client.js";
import { HEADER_REPLAY, HEADER_RESPONSE_SESSION } from "../constants.js";
import {
  APIConnectionError,
  ReplayError,
  ReplayForbiddenError,
  ReplayInvalidSessionError,
  ReplayNoSnapshotsError,
  ReplaySessionExpiredError,
  ReplaySessionNotFoundError,
} from "../errors.js";
import { replayScope, currentSessionId } from "../replay/scope.js";
import type { RelayReject } from "./relay.js";
import {
  authRejectionResponse,
  boundAndParseBody,
  extractTraceHeaders,
  forwardToFlow,
  resolveBounds,
  type FlowRelayConfig,
  type RelayBounds,
} from "./relay.js";

export interface WithNoukaiTraceOptions {
  /**
   * The Noukai client whose transport will be used to fetch the session in
   * REPLAY mode. Q8: single client per HOF instance.
   */
  client: Noukai;
}

// Minimal structural type compatible with the Web Fetch API Request (App Router)
// and hypothetical Pages Router shapes. Avoids a hard dep on `next`.
interface MinimalRequest {
  headers: {
    get(name: string): string | null;
  };
}

/**
 * Higher-order function: wraps a Next.js App Router route handler with Noukai
 * replay scope. Returns a new async handler with the same signature (plus a
 * union with `Response` for error cases).
 *
 * @param handler - The route handler to wrap.
 * @param options - Must include a configured `Noukai` client.
 */
export function withNoukaiTrace<TReq extends MinimalRequest>(
  handler: (req: TReq) => Promise<Response> | Response,
  options: WithNoukaiTraceOptions,
): (req: TReq) => Promise<Response> {
  const { client } = options;

  return async (req: TReq): Promise<Response> => {
    const replaySessionId = req.headers.get(HEADER_REPLAY) ?? undefined;

    // Use a container object so TypeScript's control-flow analysis doesn't
    // falsely infer the value is always `null` after the async closure mutates it.
    const capture: { sid: string | null } = { sid: null };

    let result: Response;
    try {
      result = await replayScope(
        async () => {
          // Read the session id from inside the scope while AsyncLocalStorage
          // is still active, then run the handler.
          capture.sid = currentSessionId();
          return await handler(req);
        },
        {
          ...(replaySessionId !== undefined ? { replaySessionId } : {}),
          transport: client._transport,
        },
      );
    } catch (e: unknown) {
      return mapReplayError(e);
    }

    // Inject X-Noukai-Session on the returned Response in capture mode.
    // We clone the response to avoid mutating an immutable Headers object when
    // the handler returns a frozen Response (e.g. `Response.json()`).
    if (capture.sid !== null) {
      const sid = capture.sid;
      const cloned = new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
      cloned.headers.set(HEADER_RESPONSE_SESSION, sid);
      return cloned;
    }

    return result;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function jsonErrorResponse(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mapReplayError(e: unknown): Response {
  if (e instanceof ReplayForbiddenError) {
    return jsonErrorResponse(403, "replay_forbidden", e.message);
  }
  if (e instanceof ReplaySessionNotFoundError) {
    return jsonErrorResponse(404, "replay_session_not_found", e.message);
  }
  if (e instanceof ReplaySessionExpiredError) {
    return jsonErrorResponse(410, "replay_session_expired", e.message);
  }
  if (e instanceof ReplayInvalidSessionError) {
    return jsonErrorResponse(400, "replay_invalid_session", e.message);
  }
  if (e instanceof ReplayNoSnapshotsError) {
    return jsonErrorResponse(409, "replay_no_snapshots", e.message);
  }
  if (e instanceof ReplayError) {
    return jsonErrorResponse(500, "replay_error", e.message);
  }
  // Non-replay error — re-throw so the caller's error boundary handles it.
  throw e;
}

// ---------------------------------------------------------------------------
// Flow relay route (design 20260903-SDK-agent-relay, PR-1)
// ---------------------------------------------------------------------------

/**
 * Options for {@link createRelayRoute}. Mirrors the Python `mount_flow_relay`
 * signature (auth hook + bounds + a pinned flow).
 */
export interface CreateRelayRouteOptions {
  /** A `Noukai` client — holds the `nk_` bearer injected on the forwarded call. */
  client: Noukai;
  org: string;
  project: string;
  slug: string;
  /**
   * Awaited before forwarding. Throw to reject; an error carrying a numeric
   * `status`/`statusCode` is honored, otherwise a `403 FORBIDDEN` is returned.
   * App authorization belongs here, never in the SDK. NOTE: returning —
   * including a falsy value — is treated as ALLOW; you MUST throw to deny.
   */
  authorize: (req: Request) => void | Promise<void>;
  /** Abuse bounds (default 256 KiB / 40). */
  bounds?: RelayBounds;
  /** `"production"` (default), `"draft"`, or a published integer version. */
  version?: "draft" | "production" | number;
}

// Statuses that must not carry a response body — the Web `Response` constructor
// throws a `TypeError` if a body is supplied with one. A verbatim relay can
// surface these from an upstream gateway/CDN (e.g. 204/304), so drop the body
// and preserve the status instead of throwing (which Next.js turns into a 500).
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function relayJson(body: unknown, status: number): Response {
  if (NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Read a Web `Request` body via its `ReadableStream`, aborting the read the
 * moment the running byte total exceeds `maxBytes`. Mirrors the Express
 * mid-read cap so a chunked / content-length-less body cannot force unbounded
 * buffering (a bare `req.text()` buffers the whole body first).
 */
async function readRequestCapped(
  req: Request,
  maxBytes: number,
): Promise<{ raw: string } | { reject: RelayReject }> {
  const stream = req.body;
  if (stream === null) return { raw: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return { reject: { status: 413, detail: "BODY_TOO_LARGE" } };
      }
      chunks.push(value);
    }
  } catch {
    return { reject: { status: 400, detail: "INVALID_JSON" } };
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return { raw: new TextDecoder().decode(merged) };
}

/**
 * Build a Next.js App Router Route Handler that relays a keyless browser POST
 * to a single flow.
 *
 * Reads the raw body (`req.text()`, with a `content-length` fast-path) → bounds
 * it → `await authorize(req)` → forwards verbatim to
 * `/seq/{org}/{project}/{slug}/execute` with the `nk_` bearer
 * (`raiseForStatus: false`) → relays the upstream `(status, body)`.
 *
 * Usage:
 *   // app/agent/execute/route.ts
 *   export const POST = createRelayRoute({ client, org, project, slug, authorize });
 */
export function createRelayRoute(
  options: CreateRelayRouteOptions,
): (req: Request) => Promise<Response> {
  const bounds = resolveBounds(options.bounds);
  const config: FlowRelayConfig = {
    client: options.client,
    org: options.org,
    project: options.project,
    slug: options.slug,
    ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
  };

  return async (req: Request): Promise<Response> => {
    // Fast-path: reject oversize bodies via the declared content-length before
    // reading at all. The streamed read below is the real cap (it aborts
    // mid-read), so a chunked / content-length-less body is also bounded.
    const contentLength = req.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > bounds.maxBodyBytes) {
      return relayJson({ detail: "BODY_TOO_LARGE" }, 413);
    }

    const read = await readRequestCapped(req, bounds.maxBodyBytes);
    if ("reject" in read) {
      return relayJson({ detail: read.reject.detail }, read.reject.status);
    }
    const parsed = boundAndParseBody(read.raw, bounds);
    if ("reject" in parsed) {
      return relayJson({ detail: parsed.reject.detail }, parsed.reject.status);
    }
    try {
      await options.authorize(req);
    } catch (e) {
      const rej = authRejectionResponse(e);
      return relayJson({ detail: rej.detail }, rej.status);
    }
    // Forward the browser's W3C trace context so an OTel-instrumented caller's
    // trace continues to Noukai. `Headers.get` is case-insensitive.
    const traceHeaders = extractTraceHeaders((name) => req.headers.get(name) ?? undefined);
    try {
      const outcome = await forwardToFlow(config, parsed.payload, traceHeaders);
      return relayJson(outcome.body, outcome.status);
    } catch (e) {
      // No upstream status to relay (connection/timeout) — signal 502.
      if (e instanceof APIConnectionError) {
        return relayJson({ detail: "UPSTREAM_UNAVAILABLE" }, 502);
      }
      throw e;
    }
  };
}
