/**
 * Express/Connect middleware for the Noukai replay feature.
 *
 * Reads `X-Noukai-Replay` from the incoming request, opens a `replayScope`
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
 * phase doc § 8.4):** By the time `replayScope`'s callback resolves, Express has
 * already committed the response. Hooking `res.on("finish")` is too late —
 * headers are already flushed. Monkey-patching `res.writeHead` is the only
 * reliable interception point before headers are sent. We do it once at
 * middleware entry and restore to the original function after the first call.
 *
 * **Wrapping `next` in a Promise:** Express doesn't return a Promise from
 * `next()`. To run the handler chain inside `AsyncLocalStorage.run` (via
 * `replayScope`) we wrap `next` in a Promise that resolves/rejects when the
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
  APIConnectionError,
  ReplayError,
  ReplayForbiddenError,
  ReplayInvalidSessionError,
  ReplayNoSnapshotsError,
  ReplaySessionExpiredError,
  ReplaySessionNotFoundError,
} from "../errors.js";
import { replayScope, currentSessionId } from "../replay/scope.js";
import {
  authRejectionResponse,
  boundAndParseBody,
  forwardToFlow,
  resolveBounds,
  type FlowRelayConfig,
  type RelayBounds,
  type RelayReject,
} from "./relay.js";

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
    // inside replayScope (which runs the body inside AsyncLocalStorage.run).
    replayScope(
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

// ---------------------------------------------------------------------------
// Flow relay handler (design 20260903-SDK-agent-relay, PR-1)
// ---------------------------------------------------------------------------

/**
 * Options for {@link noukaiRelayHandler}. Mirrors the Python
 * `mount_flow_relay` signature (auth hook + bounds + a pinned flow).
 */
export interface NoukaiRelayHandlerOptions {
  /** A `Noukai` client — holds the `nk_` bearer injected on the forwarded call. */
  client: Noukai;
  org: string;
  project: string;
  slug: string;
  /**
   * Awaited before forwarding. Throw to reject; an error carrying a numeric
   * `status`/`statusCode` is honored, otherwise a `403 FORBIDDEN` is returned.
   * App authorization (e.g. a maker-role check) belongs here, never in the SDK.
   * NOTE: returning — including a falsy value — is treated as ALLOW; you MUST
   * throw to deny.
   */
  authorize: (req: RelayExpressRequest) => void | Promise<void>;
  /** Abuse bounds (default 256 KiB / 40). */
  bounds?: RelayBounds;
  /** `"production"` (default), `"draft"`, or a published integer version. */
  version?: "draft" | "production" | number;
}

/**
 * Minimal Express request shape — a Node `IncomingMessage` is async-iterable,
 * so the handler streams the raw body with a hard byte cap. Avoids a hard dep
 * on `@types/express`.
 */
export interface RelayExpressRequest extends AsyncIterable<Uint8Array | string> {
  headers: Record<string, string | string[] | undefined>;
  /** Some setups pre-parse the body; used as a fallback when the stream is empty. */
  body?: unknown;
}

interface RelayExpressResponse {
  status(code: number): RelayExpressResponse;
  json(body: unknown): void;
}

function concatToString(chunks: Uint8Array[]): string {
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}

async function readExpressRawBody(
  req: RelayExpressRequest,
  maxBytes: number,
): Promise<{ raw: string } | { reject: RelayReject }> {
  const pre = (req as { rawBody?: unknown }).rawBody ?? req.body;
  if (typeof pre === "string") {
    return { raw: pre };
  }
  if (typeof req[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const enc = new TextEncoder();
    try {
      for await (const chunk of req) {
        const buf = typeof chunk === "string" ? enc.encode(chunk) : chunk;
        total += buf.length;
        if (total > maxBytes) {
          return { reject: { status: 413, detail: "BODY_TOO_LARGE" } };
        }
        chunks.push(buf);
      }
    } catch {
      return { reject: { status: 400, detail: "INVALID_JSON" } };
    }
    const raw = concatToString(chunks);
    // Fall back to a pre-parsed object body when the stream was already drained.
    if (raw === "" && pre !== undefined && pre !== null && typeof pre === "object") {
      return { raw: preToRaw(pre) };
    }
    return { raw };
  }
  if (pre !== undefined && pre !== null && typeof pre === "object") {
    return { raw: preToRaw(pre) };
  }
  return { raw: "" };
}

/**
 * Turn a pre-parsed body fallback into raw text. A `Buffer` / `Uint8Array`
 * (e.g. from `express.raw()`) is decoded as UTF-8; anything else is a
 * parsed object which we re-serialize. Guards against a `Buffer` being
 * `JSON.stringify`d into `{"type":"Buffer","data":[...]}` garbage.
 */
function preToRaw(pre: object): string {
  if (pre instanceof Uint8Array) return new TextDecoder().decode(pre);
  return JSON.stringify(pre);
}

/**
 * Build an Express handler that relays a keyless browser POST to a single flow.
 *
 * Reads the raw body (byte-capped) → bounds it → `await authorize(req)` →
 * forwards verbatim to `/seq/{org}/{project}/{slug}/execute` with the `nk_`
 * bearer (`raiseForStatus: false`) → relays the upstream `(status, body)`.
 *
 * Mount without a JSON body parser on that route so the handler sees raw bytes:
 *   app.post("/agent/execute", noukaiRelayHandler({ client, org, project, slug, authorize }));
 */
export function noukaiRelayHandler(
  options: NoukaiRelayHandlerOptions,
): (req: RelayExpressRequest, res: RelayExpressResponse) => Promise<void> {
  const bounds = resolveBounds(options.bounds);
  const config: FlowRelayConfig = {
    client: options.client,
    org: options.org,
    project: options.project,
    slug: options.slug,
    ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
  };

  return async (req, res) => {
    const read = await readExpressRawBody(req, bounds.maxBodyBytes);
    if ("reject" in read) {
      res.status(read.reject.status).json({ detail: read.reject.detail });
      return;
    }
    const parsed = boundAndParseBody(read.raw, bounds);
    if ("reject" in parsed) {
      res.status(parsed.reject.status).json({ detail: parsed.reject.detail });
      return;
    }
    try {
      await options.authorize(req);
    } catch (e) {
      const rej = authRejectionResponse(e);
      res.status(rej.status).json({ detail: rej.detail });
      return;
    }
    let outcome;
    try {
      outcome = await forwardToFlow(config, parsed.payload);
    } catch (e) {
      // No upstream status to relay (connection/timeout) — signal 502 rather
      // than leaving the promise to reject unhandled (Express ignores it).
      if (e instanceof APIConnectionError) {
        res.status(502).json({ detail: "UPSTREAM_UNAVAILABLE" });
        return;
      }
      throw e;
    }
    res.status(outcome.status).json(outcome.body);
  };
}
