import type { LogEvent } from "./client.js";
import {
  HEADER_API_VERSION,
  HEADER_REQUEST_ID,
  HEADER_USER_AGENT,
  API_VERSION,
} from "./constants.js";
import { VERSION } from "./version.js";
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  PermissionDeniedError,
  FlowNotFoundError,
  InsufficientCreditsError,
  RateLimitError,
  FlowExecutionError,
} from "./errors.js";
import type { NoukaiError } from "./errors.js";
import { detectRuntime, runtimeVersion } from "./internal/runtime.js";
import { NoopSpanFactory, type SpanFactory } from "./otel.js";

// ---------------------------------------------------------------------------
// Public interface types
// ---------------------------------------------------------------------------

export interface TransportResponse<T = unknown> {
  statusCode: number;
  body: T | null;
  requestId: string | null;
  headers: Headers;
}

export interface RequestOptions {
  json?: unknown;
  params?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  /** Per-request headers merged on top of the client-level base headers. */
  extraHeaders?: Record<string, string>;
  /**
   * When `true` (default) a non-2xx response throws the mapped typed error.
   * When `false`, the `TransportResponse` is returned even on non-2xx (retries
   * still apply for retryable statuses first). The relay adapter uses this to
   * forward upstream 4xx/5xx statuses to the browser verbatim
   * (design 20260903-SDK-agent-relay). Connection/timeout errors still throw
   * regardless — there is no response to return.
   */
  raiseForStatus?: boolean;
  /**
   * When `false`, a retryable status (429/5xx) is NOT retried — the first
   * response is used as-is. Defaults to retrying (today's behavior). The relay
   * forward sets this so a non-idempotent POST is never silently re-submitted,
   * matching the Python transport (which never retries POST/PATCH).
   */
  idempotent?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Backoff in milliseconds: attempt 0 → 1 000 ms, attempt 1 → 4 000 ms,
 * attempt 2 → 16 000 ms. Formula: attempt === 0 ? 1000 : 4 ** attempt * 1000.
 */
function backoffMs(attempt: number): number {
  return attempt === 0 ? 1_000 : Math.pow(4, attempt) * 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Combine multiple AbortSignals into one. Uses `AbortSignal.any` when
 * available (Node 20.3+), otherwise chains via a derived AbortController.
 */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  /* v8 ignore next 3 -- unreachable: we always pass at least the timeout signal */
  if (defined.length === 0) {
    return new AbortController().signal; // never-aborting signal
  }
  if (defined.length === 1) {
    // defined[0] is always AbortSignal here (filtered above), but noUncheckedIndexedAccess
    // makes it AbortSignal | undefined. Guard with a destructure to satisfy the linter.
    const [first] = defined;
    if (first !== undefined) return first;
  }
  // AbortSignal.any is Node 20.3+ / modern browsers
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(defined);
  }
  /* v8 ignore next 11 -- AbortSignal.any fallback for Node <20.3 / older runtimes */
  // Fallback: chain via derived controller
  const controller = new AbortController();
  for (const sig of defined) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener("abort", () => { controller.abort(sig.reason); }, { once: true });
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Reserved headers — never overridable via per-request `extraHeaders`
// ---------------------------------------------------------------------------

/**
 * Headers managed by the transport itself. A caller passing one of these via
 * `extraHeaders` would silently overwrite auth, version pinning, or request-id
 * provenance — `applyExtraHeaders` strips them instead. The replay subsystem
 * is the main caller of `extraHeaders` (for `X-Session-Id` / `X-Noukai-Replay`),
 * and adding a hardened allowlist here means a misconfigured `replayScope` cannot
 * exfiltrate or rotate the bearer token by accident.
 *
 * Compared case-insensitively. The `Set` stores lower-case canonical forms.
 */
const RESERVED_HEADER_LOWER = new Set<string>([
  "authorization",
  HEADER_API_VERSION.toLowerCase(),
  HEADER_USER_AGENT.toLowerCase(),
  HEADER_REQUEST_ID.toLowerCase(),
  "content-type",
  "cookie",
]);

/**
 * Merge `extraHeaders` onto `target`, silently dropping any reserved keys.
 * Exported for unit tests; not part of the public API.
 *
 * @internal
 */
export function applyExtraHeaders(
  target: Headers,
  extraHeaders: Record<string, string> | undefined,
): void {
  if (extraHeaders === undefined) return;
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (RESERVED_HEADER_LOWER.has(k.toLowerCase())) continue;
    target.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Error body types
// ---------------------------------------------------------------------------

interface ErrorDetail {
  code: string;
  message: string;
}

function parseErrorDetail(body: unknown): ErrorDetail | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const detail = b.detail;
  if (detail === null || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.code !== "string" || typeof d.message !== "string") return null;
  return { code: d.code, message: d.message };
}

/**
 * Best-effort human-readable message for an error body that is NOT the standard
 * `{detail:{code,message}}` shape. Avoids `String(body)` producing
 * "[object Object]" for a plain-object error body (e.g. a proxy's `{error:"…"}`
 * or a bare `{}`) — surfaces a top-level `message`/`error` string, else the
 * JSON, else the HTTP status.
 */
function errorMessageFromBody(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string" && b.message.length > 0) return b.message;
    if (typeof b.error === "string" && b.error.length > 0) return b.error;
    try {
      const s = JSON.stringify(body);
      if (s !== "{}") return s;
    } catch {
      /* fall through to status */
    }
    return `HTTP ${String(status)}`;
  }
  return String(body);
}

function mapStatusToError(
  status: number,
  body: unknown,
  headers: Headers,
  requestId: string | null,
): NoukaiError {
  const detail = parseErrorDetail(body);
  const code = detail?.code;
  const message = detail?.message ?? errorMessageFromBody(body, status);

  // Build init carefully for exactOptionalPropertyTypes: omit undefined optionals.
  const baseInit = {
    statusCode: status,
    responseBody: body,
    ...(code !== undefined ? { code } : {}),
    ...(requestId !== null ? { requestId } : {}),
  };

  switch (status) {
    case 401:
      return new AuthenticationError(message, baseInit);
    case 402:
      return new InsufficientCreditsError(message, baseInit);
    case 403:
      return new PermissionDeniedError(message, baseInit);
    case 404:
      return new FlowNotFoundError(message, baseInit);
    case 429: {
      const retryAfterRaw = headers.get("Retry-After");
      const retryAfter =
        retryAfterRaw !== null ? parseInt(retryAfterRaw, 10) : undefined;
      return new RateLimitError(message, {
        ...baseInit,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      });
    }
    default:
      return new FlowExecutionError(message, baseInit);
  }
}

/**
 * Map an `(status, body)` to the SDK's typed error, for callers that hold a
 * status+body but not a `Response` (the execute-transport seam: a relay returns
 * the upstream status verbatim and the shared loop maps a non-2xx here — the
 * same taxonomy the direct transport throws). Headers are absent, so
 * header-derived fields like `Retry-After` are not populated.
 *
 * @internal
 */
export function errorForExecuteStatus(status: number, body: unknown): NoukaiError {
  return mapStatusToError(status, body, new Headers(), null);
}

// ---------------------------------------------------------------------------
// User-Agent builder
// ---------------------------------------------------------------------------

function buildUserAgent(): string {
  const runtime = detectRuntime();
  const version = runtimeVersion(runtime);
  if (runtime === "node") {
    return `@noukai/sdk@${VERSION} (${runtime}/${version}; ${process.platform})`;
  }
  /* v8 ignore next 5 -- non-Node runtime UA paths; exercised in Bun/Deno environments */
  if (version !== "unknown") {
    return `@noukai/sdk@${VERSION} (${runtime}/${version})`;
  }
  return `@noukai/sdk@${VERSION} (${runtime})`;
}

// ---------------------------------------------------------------------------
// Transport class
// ---------------------------------------------------------------------------

export class Transport {
  /**
   * Resolved API key. Public for test introspection; do not mutate at runtime.
   */
  public readonly apiKey: string;
  /**
   * Resolved base URL (trailing slash stripped). Public for test introspection;
   * do not mutate at runtime.
   */
  public readonly baseUrl: string;
  /**
   * Client-level default session id (set via `Noukai({ sessionId })`).
   * `Flow.execute` reads this as middle precedence between per-call `sessionId`
   * and the AsyncLocalStorage contextvar scope.
   */
  public readonly defaultSessionId: string | undefined;
  /** OTel span factory; a no-op unless the client opted in with `otel: true`. */
  public readonly spanFactory: SpanFactory;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly onLog?: ((event: LogEvent) => void) | undefined;
  private readonly logPayloads: boolean;
  private readonly clientSignal?: AbortSignal | undefined;
  /** Base headers sent with every request. Built once, copied per request. */
  private readonly _headers: Headers;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    timeout: number;
    maxRetries: number;
    onLog?: ((event: LogEvent) => void) | undefined;
    logPayloads: boolean;
    clientSignal?: AbortSignal | undefined;
    defaultSessionId?: string | undefined;
    spanFactory?: SpanFactory | undefined;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.timeout = options.timeout;
    this.maxRetries = options.maxRetries;
    this.onLog = options.onLog;
    this.logPayloads = options.logPayloads;
    this.clientSignal = options.clientSignal;
    this.defaultSessionId = options.defaultSessionId;
    this.spanFactory = options.spanFactory ?? new NoopSpanFactory();

    this._headers = new Headers();
    this._headers.set("Authorization", `Bearer ${this.apiKey}`);
    this._headers.set(HEADER_API_VERSION, API_VERSION);
    this._headers.set(HEADER_USER_AGENT, buildUserAgent());
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveUrl(path: string, params?: Record<string, string>): string {
    // Ensure exactly one slash between base and path
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    let url = `${this.baseUrl}${normalizedPath}`;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params).toString();
      url = `${url}?${qs}`;
    }
    return url;
  }

  /** Build a fresh Headers object for this request (so mutations don't bleed). */
  private buildHeaders(hasBody: boolean): Headers {
    const h = new Headers(this._headers);
    if (hasBody) {
      h.set("Content-Type", "application/json");
    }
    return h;
  }

  private log(event: LogEvent): void {
    try {
      this.onLog?.(event);
    } catch {
      // Swallow log hook errors — never break the caller.
    }
  }

  /**
   * Emit a log event via the configured `onLog` hook.
   *
   * Exposed for `replayScope` to emit `scope_open` / `scope_close` events.
   * No-op when no `onLog` hook is configured.
   */
  public _emitLog(event: LogEvent): void {
    this.log(event);
  }

  private async safeJson(resp: Response): Promise<unknown> {
    let text: string;
    try {
      text = await resp.text();
    } catch {
      // Body already consumed (e.g. same Response object reused in tests) or
      // stream error — return null rather than propagating.
      return null;
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<TransportResponse<T>> {
    const url = this.resolveUrl(path, opts.params);
    const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
    const callTimeout = opts.timeout ?? this.timeout;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Log the outgoing request
      this.log({
        phase: "request",
        method,
        path,
        attempt,
        ...(this.logPayloads && opts.json !== undefined
          ? { requestBody: opts.json }
          : {}),
      });

      // Build per-request abort signal combining timeout + user signal + client signal
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(
        () => { timeoutController.abort(); },
        callTimeout,
      );

      const signal = combineSignals([
        timeoutController.signal,
        opts.signal,
        this.clientSignal,
      ]);

      const requestHeaders = this.buildHeaders(body !== undefined);
      applyExtraHeaders(requestHeaders, opts.extraHeaders);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: requestHeaders,
          ...(body !== undefined ? { body } : {}),
          signal,
        });
      } catch (e) {
        clearTimeout(timeoutHandle);
        // AbortError — check both DOMException form and plain Error form
        if (
          (e instanceof DOMException && e.name === "AbortError") ||
          (e instanceof Error && e.name === "AbortError")
        ) {
          throw new APITimeoutError(
            e instanceof Error ? e.message : "Request timed out",
            { cause: e },
          );
        }
        throw new APIConnectionError(
          e instanceof Error ? e.message : String(e),
          { cause: e },
        );
      }
      clearTimeout(timeoutHandle);

      const requestId = resp.headers.get(HEADER_REQUEST_ID);
      const bodyData = await this.safeJson(resp);

      // Log the response
      this.log({
        phase: "response",
        method,
        path,
        attempt,
        statusCode: resp.status,
        ...(requestId !== null ? { requestId } : {}),
        ...(this.logPayloads ? { responseBody: bodyData } : {}),
      });

      // Success
      if (resp.ok) {
        return {
          statusCode: resp.status,
          body: bodyData as T,
          requestId,
          headers: resp.headers,
        };
      }

      // Retryable 5xx (and 429) — retry if we have attempts left
      // Note: 429 is retryable by backoff but we still throw after exhaustion
      if (
        opts.idempotent !== false &&
        RETRYABLE_STATUS.has(resp.status) &&
        attempt < this.maxRetries
      ) {
        this.log({
          phase: "retry",
          method,
          path,
          attempt,
          statusCode: resp.status,
          ...(requestId !== null ? { requestId } : {}),
        });
        await sleep(backoffMs(attempt));
        continue;
      }

      // Non-raising mode (relay adapter): hand the response back on non-2xx
      // instead of throwing, so a verbatim relay can forward the upstream
      // status/body through unchanged. Retries above still applied first.
      if (opts.raiseForStatus === false) {
        return {
          statusCode: resp.status,
          body: bodyData as T,
          requestId,
          headers: resp.headers,
        };
      }

      // Non-retryable or exhausted — throw typed error
      throw mapStatusToError(resp.status, bodyData, resp.headers, requestId);
    }

    // Should never reach here — the loop always either returns or throws
    throw new APIConnectionError("transport loop exited unexpectedly");
  }

  async *stream(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): AsyncIterable<Uint8Array> {
    const url = this.resolveUrl(path, opts.params);
    const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
    const callTimeout = opts.timeout ?? this.timeout;

    this.log({
      phase: "request",
      method,
      path,
      attempt: 0,
      ...(this.logPayloads && opts.json !== undefined
        ? { requestBody: opts.json }
        : {}),
    });

    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(
      () => { timeoutController.abort(); },
      callTimeout,
    );

    const signal = combineSignals([
      timeoutController.signal,
      opts.signal,
      this.clientSignal,
    ]);

    const streamHeaders = this.buildHeaders(body !== undefined);
    applyExtraHeaders(streamHeaders, opts.extraHeaders);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers: streamHeaders,
        ...(body !== undefined ? { body } : {}),
        signal,
      });
    } catch (e) {
      clearTimeout(timeoutHandle);
      if (
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        throw new APITimeoutError(
          e instanceof Error ? e.message : "Request timed out",
          { cause: e },
        );
      }
      throw new APIConnectionError(
        e instanceof Error ? e.message : String(e),
        { cause: e },
      );
    }

    const requestId = resp.headers.get(HEADER_REQUEST_ID);

    this.log({
      phase: "response",
      method,
      path,
      attempt: 0,
      statusCode: resp.status,
      ...(requestId !== null ? { requestId } : {}),
    });

    if (!resp.ok) {
      clearTimeout(timeoutHandle);
      const bodyData = await this.safeJson(resp);
      throw mapStatusToError(resp.status, bodyData, resp.headers, requestId);
    }

    if (resp.body === null) {
      clearTimeout(timeoutHandle);
      return;
    }

    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
      clearTimeout(timeoutHandle);
    }
  }

  async close(): Promise<void> {
    // No persistent connections to clean up in fetch-based transport.
    // This is a no-op; provided for symmetry with the Python SDK.
  }
}
