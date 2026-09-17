import { Flow } from "./flow.js";
import { Transport } from "./transport.js";
import {
  API_KEY_ENV_VAR,
  API_KEY_PREFIX,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DEV_BASE_URL,
  ENV_ENV_VAR,
} from "./constants.js";
import { AuthenticationError } from "./errors.js";
import { makeSpanFactory } from "./otel.js";

/** Deployment environment shortcut for the base URL. */
export type NoukaiEnv = "dev" | "production";

export interface NoukaiOptions {
  /** API key starting with `nk_`. Falls back to `process.env.NOUKAI_API_KEY`. */
  apiKey?: string;
  /**
   * Deployment shortcut: `"dev"` points at `http://localhost:8080/api/v1`;
   * `"production"` (default) points at `https://api.noukai.dev/api/v1`.
   * Falls back to `process.env.NOUKAI_ENV`.
   *
   * Note: the SDK does not accept an arbitrary base URL. All requests target
   * Noukai's hosted endpoints — `env` is the only deployment knob.
   */
  env?: NoukaiEnv;
  /**
   * Default organisation. When set with `project`, `noukai.flow("slug")` uses
   * the single slug; a fully-qualified `"org/project/slug"` still overrides.
   */
  org?: string;
  /** Default project. Required when `org` is set. */
  project?: string;
  /** Default per-request timeout (ms). Default: 300_000. */
  timeout?: number;
  /** Default retry count on retryable 5xx. Default: 1. */
  maxRetries?: number;
  /** Optional structured logging hook. Receives request/response/retry events. */
  onLog?: (event: LogEvent) => void;
  /** When true, request/response bodies are included in log events. Default: false. */
  logPayloads?: boolean;
  /**
   * Client-level default session id.
   * Precedence: per-call `sessionId` option > this default > AsyncLocalStorage scope.
   */
  sessionId?: string; // NEW — Phase 2
  /**
   * Opt into customer-side OpenTelemetry. When `true`, each `flow.execute` /
   * `flow.executeAsync` call emits one span of kind CLIENT into your configured
   * OpenTelemetry provider. Requires the `@opentelemetry/api` optional peer
   * dependency. Default `false` — a true no-op that never imports OpenTelemetry.
   * (design 20260916-SDK-otel-and-replay-rename)
   */
  otel?: boolean;
  /** Explicit OpenTelemetry `Tracer` to use instead of the global provider. */
  tracer?: unknown;
  /** AbortSignal for full-client cancellation (cancels all in-flight requests). */
  signal?: AbortSignal;
}

/**
 * Resolve the base URL from the deployment env shortcut:
 * 1. `env: "dev"` option OR `NOUKAI_ENV=dev` env var → DEV_BASE_URL
 * 2. production default
 */
function resolveBaseUrl(options: NoukaiOptions): string {
  const envMode = options.env ?? process.env[ENV_ENV_VAR];
  if (envMode === "dev" || envMode === "development") return DEV_BASE_URL;
  return DEFAULT_BASE_URL;
}

export interface LogEvent {
  phase: "request" | "response" | "retry" | "scope_open" | "scope_close";
  /** Present on request / response / retry phases only. */
  method?: string;
  /** Present on request / response / retry phases only. */
  path?: string;
  /** Present on request / response / retry phases only. */
  attempt?: number;
  statusCode?: number;
  requestId?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  /** Present on scope_open / scope_close phases only. */
  mode?: "normal" | "capture" | "replay";
  /** Present on scope_open / scope_close phases only. */
  sessionId?: string | null;
}

export type FlowIdentifier = string | { org: string; project: string; slug: string };

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function parseFlowIdentifier(
  id: FlowIdentifier,
  defaults: { org?: string | undefined; project?: string | undefined },
): { org: string; project: string; slug: string } {
  if (typeof id === "string") {
    const parts = id.split("/");

    // Single-segment slug uses client-level defaults.
    if (parts.length === 1) {
      const [slug] = parts;
      if (!slug) {
        throw new Error("Slug string is empty.");
      }
      if (!defaults.org || !defaults.project) {
        throw new Error(
          `flow("${id}") requires the client to be constructed with org and ` +
            `project defaults: new Noukai({ org, project, ... }). Otherwise ` +
            `pass a fully-qualified "org/project/slug" string.`,
        );
      }
      return { org: defaults.org, project: defaults.project, slug };
    }

    // Three-segment slug is fully qualified — overrides defaults.
    if (parts.length === 3 && !parts.some((p) => !p)) {
      const [org, project, slug] = parts as [string, string, string];
      return { org, project, slug };
    }

    throw new Error(
      `Slug string must be either a single slug name (with client org/project ` +
        `defaults) or "org/project/slug"; got: ${id}`,
    );
  }
  if (!id.org || !id.project || !id.slug) {
    throw new Error("Kwargs form requires non-empty org, project, slug.");
  }
  return { org: id.org, project: id.project, slug: id.slug };
}

// ---------------------------------------------------------------------------
// Noukai client
// ---------------------------------------------------------------------------

export class Noukai {
  /** @internal — backing field; access via `_transport` getter. */
  private readonly __transport: Transport;

  /** Default organisation, if set via constructor. */
  readonly defaultOrg: string | undefined;
  /** Default project, if set via constructor. */
  readonly defaultProject: string | undefined;
  /**
   * Client-level default session id, if set via constructor.
   * Propagated to all `flow(...)` proxies; per-call `sessionId` takes precedence.
   */
  readonly defaultSessionId: string | undefined; // NEW — Phase 2

  /**
   * Construct a Noukai client.
   *
   * @throws {AuthenticationError} If no API key is found or the prefix is wrong.
   * @throws {Error} If `org` is set without `project` (or vice versa).
   */
  constructor(options: NoukaiOptions = {}) {
    // Resolve API key: explicit option wins over env var.
    const apiKey = options.apiKey ?? process.env[API_KEY_ENV_VAR];
    if (!apiKey) {
      throw new AuthenticationError(
        `No API key provided. Pass apiKey or set ${API_KEY_ENV_VAR}.`,
      );
    }
    if (!apiKey.startsWith(API_KEY_PREFIX)) {
      throw new AuthenticationError(
        `Invalid API key prefix. Expected '${API_KEY_PREFIX}'.`,
      );
    }

    // org and project must be set together — half-defaults are a footgun.
    if ((options.org === undefined) !== (options.project === undefined)) {
      throw new Error(
        "Noukai: `org` and `project` must be provided together, or both omitted.",
      );
    }
    this.defaultOrg = options.org;
    this.defaultProject = options.project;
    this.defaultSessionId = options.sessionId; // NEW — Phase 2

    const baseUrl = resolveBaseUrl(options);

    this.__transport = new Transport({
      apiKey,
      baseUrl,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      onLog: options.onLog,
      logPayloads: options.logPayloads ?? false,
      clientSignal: options.signal,
      spanFactory: makeSpanFactory(options.otel ?? false, options.tracer),
      ...(options.sessionId !== undefined ? { defaultSessionId: options.sessionId } : {}),
    });

    // Warn when used in a browser context — API keys should not be in client-side code.
    if ("window" in globalThis) {
      console.warn(
        "Noukai: API keys should not be exposed in client-side code. " +
          "Use the SDK from a server runtime (Node, Bun, Workers, etc.) only.",
      );
    }
  }

  /**
   * @internal Exposed for test inspection only. Not part of the public API.
   * Tests may access via `(noukai as any)._transport.apiKey` /
   * `(noukai as any)._transport.baseUrl`.
   */
  public get _transport(): Transport {
    return this.__transport;
  }

  /**
   * Bind a Flow object for execution.
   *
   * Three forms:
   *   noukai.flow("slug")                                  // uses client org+project defaults
   *   noukai.flow("org/project/slug")                      // fully qualified
   *   noukai.flow({ org: "...", project: "...", slug: "..." })
   *
   * @throws {Error} If single-segment slug given without client defaults set,
   *   if string is malformed, or if kwargs are missing fields.
   */
  flow(identifier: FlowIdentifier): Flow {
    const { org, project, slug } = parseFlowIdentifier(identifier, {
      org: this.defaultOrg,
      project: this.defaultProject,
    });
    return new Flow({ transport: this.__transport, org, project, slug });
  }

  /** Release the underlying connection pool. Safe to call multiple times. */
  async close(): Promise<void> {
    await this.__transport.close();
  }

  /** Async disposal for `await using` (Node 22+, TS 5.2+). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
