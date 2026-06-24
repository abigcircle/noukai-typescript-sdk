/**
 * Next.js App Router higher-order function adapter for the Noukai trace feature.
 *
 * Wraps a route handler function to read `X-Noukai-Replay` from the incoming
 * request, open a `traceScope` around the handler, and write `X-Noukai-Session`
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
 * `traceScope` before the handler body runs. We read it with `currentSessionId()`
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
  ReplayError,
  ReplayForbiddenError,
  ReplayInvalidSessionError,
  ReplayNoSnapshotsError,
  ReplaySessionExpiredError,
  ReplaySessionNotFoundError,
} from "../errors.js";
import { traceScope, currentSessionId } from "../replay/scope.js";

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
 * trace scope. Returns a new async handler with the same signature (plus a
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
      result = await traceScope(
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
