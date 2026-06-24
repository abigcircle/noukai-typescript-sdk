/**
 * Express/Connect middleware for the Noukai trace feature.
 *
 * Reads `X-Noukai-Replay` from the incoming request, opens a `traceScope`
 * around the downstream handler chain, and writes `X-Noukai-Session` on the
 * response in capture mode.
 *
 * Usage:
 *   import { noukaiTraceMiddleware } from "@noukai/sdk/adapters/express";
 *   app.use(noukaiTraceMiddleware({ client: noukai }));
 *
 * Design decisions:
 *
 * **Single client per middleware instance (Q8):** The constructor accepts one
 * `Noukai` client. Multi-client apps can install multiple middleware instances
 * or introduce a per-request client factory — that is deferred to v1.1.
 *
 * **Response header injection via `res.writeHead` monkey-patch (Option B from
 * phase doc § 8.4):** By the time `traceScope`'s callback resolves, Express has
 * already committed the response. Hooking `res.on("finish")` is too late —
 * headers are already flushed. Monkey-patching `res.writeHead` is the only
 * reliable interception point before headers are sent. We do it once at
 * middleware entry and restore to the original function after the first call.
 *
 * **Wrapping `next` in a Promise:** Express doesn't return a Promise from
 * `next()`. To run the handler chain inside `AsyncLocalStorage.run` (via
 * `traceScope`) we wrap `next` in a Promise that resolves/rejects when the
 * downstream handler signals completion. This is the same pattern used by
 * `express-async-handler`.
 *
 * **First X-Noukai-Replay value wins:** per spec, one session id per request.
 * If multiple values arrive (non-standard) we use the first.
 */

import type { Noukai } from "../client.js";
import {
  HEADER_REPLAY,
  HEADER_RESPONSE_SESSION,
} from "../constants.js";
import {
  ReplayError,
  ReplayForbiddenError,
  ReplayInvalidSessionError,
  ReplayNoSnapshotsError,
  ReplaySessionExpiredError,
  ReplaySessionNotFoundError,
} from "../errors.js";
import { traceScope, currentSessionId } from "../replay/scope.js";

export interface NoukaiTraceMiddlewareOptions {
  /**
   * The Noukai client whose transport will be used to fetch the session in
   * REPLAY mode. Required so the middleware doesn't need to construct its own.
   *
   * Q8 resolution: single client per middleware instance. Multi-client apps
   * install multiple instances or factor out to v1.1.
   */
  client: Noukai;
}

// ---------------------------------------------------------------------------
// Minimal structural types — avoids a hard dependency on @types/express.
// ---------------------------------------------------------------------------

interface MinimalReq {
  headers: Record<string, string | string[] | undefined>;
}

interface ExtendedRes {
  setHeader(name: string, value: string): void;
  status(code: number): ExtendedRes;
  json(body: unknown): void;
  headersSent: boolean;
  // Express/Node http.ServerResponse low-level hook we monkey-patch.
  writeHead: (...args: unknown[]) => unknown;
}

type NextFn = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function noukaiTraceMiddleware(
  options: NoukaiTraceMiddlewareOptions,
): (req: MinimalReq, res: ExtendedRes, next: NextFn) => void {
  const { client } = options;

  return (req, res, next) => {
    // Read X-Noukai-Replay header. Take the first value when multiple are sent.
    const headerVal = req.headers[HEADER_REPLAY.toLowerCase()];
    const replaySessionId: string | undefined = Array.isArray(headerVal)
      ? headerVal[0]
      : headerVal;

    // ---------------------------------------------------------------------------
    // Option B: monkey-patch res.writeHead to inject the session header before
    // the response is committed. This is the only interception point guaranteed
    // to run before headers are flushed to the client.
    // ---------------------------------------------------------------------------
    const originalWriteHead: ExtendedRes["writeHead"] = res.writeHead.bind(res);
    let headerInjected = false;

    res.writeHead = (...args: unknown[]): unknown => {
      if (!headerInjected) {
        headerInjected = true;
        const sid = currentSessionId();
        if (sid !== null) {
          res.setHeader(HEADER_RESPONSE_SESSION, sid);
        }
      }
      return originalWriteHead(...args);
    };

    // Wrap `next` in a Promise so we can await the downstream chain completion
    // inside traceScope (which runs the body inside AsyncLocalStorage.run).
    traceScope(
      () =>
        new Promise<void>((resolve, reject) => {
          const wrappedNext: NextFn = (err?: unknown) => {
            if (err !== undefined) {
              reject(err instanceof Error ? err : new Error(`next() called with error: ${JSON.stringify(err)}`));
            } else {
              resolve();
            }
          };
          next(wrappedNext);
        }),
      {
        ...(replaySessionId !== undefined ? { replaySessionId } : {}),
        transport: client._transport,
      },
    ).catch((e: unknown) => {
      // Restore original writeHead so error responses use the unpatched path.
      res.writeHead = originalWriteHead;

      if (res.headersSent) {
        // Response is already committed — pass to Express error handler.
        next(e);
        return;
      }

      if (e instanceof ReplayForbiddenError) {
        res.status(403).json({ error: "replay_forbidden", message: e.message });
      } else if (e instanceof ReplaySessionNotFoundError) {
        res.status(404).json({ error: "replay_session_not_found", message: e.message });
      } else if (e instanceof ReplaySessionExpiredError) {
        res.status(410).json({ error: "replay_session_expired", message: e.message });
      } else if (e instanceof ReplayInvalidSessionError) {
        res.status(400).json({ error: "replay_invalid_session", message: e.message });
      } else if (e instanceof ReplayNoSnapshotsError) {
        res.status(409).json({ error: "replay_no_snapshots", message: e.message });
      } else if (e instanceof ReplayError) {
        res.status(500).json({ error: "replay_error", message: e.message });
      } else {
        next(e);
      }
    });
  };
}
