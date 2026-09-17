/**
 * Replay session fetcher — Phase 6 implementation.
 *
 * This module is dynamically imported by replayScope() only when REPLAY mode
 * is active (NOUKAI_REPLAY_ENABLED=true + replaySessionId set). Phase 4 creates
 * the stub; Phase 6 fills the body.
 */

import type { SessionResponse } from "../types/session.js";
import type { Transport } from "../transport.js";
import {
  ReplayForbiddenError,
  ReplaySessionNotFoundError,
  ReplaySessionExpiredError,
  ReplayInvalidSessionError,
} from "../errors.js";
import { DEFAULT_BASE_URL, DEV_BASE_URL, ENV_ENV_VAR } from "../constants.js";
import { sessionPath } from "../paths.js";

/**
 * Resolve the base URL for the session fetch. When a transport is provided,
 * use its configured baseUrl. Otherwise derive from env (same logic as the
 * Noukai client constructor).
 */
function resolveBaseUrl(transport: Transport | undefined): string {
  if (transport !== undefined) {
    return transport.baseUrl;
  }
  const envMode = process.env[ENV_ENV_VAR] ?? "";
  return envMode === "dev" || envMode === "development" ? DEV_BASE_URL : DEFAULT_BASE_URL;
}

/**
 * Fetch a recorded session from the server.
 *
 * When `transport` is provided its configured base URL and auth headers are
 * used. When absent (e.g. in tests that mock globalThis.fetch), falls back to
 * bare fetch against the env-derived base URL with no auth header — acceptable
 * for test scenarios that stub the entire fetch response.
 *
 * Maps HTTP error codes to typed replay errors so callers can distinguish
 * 403 (access denied), 404 (not found), 410 (TTL expired), and 400 (bad
 * session id format).
 *
 * @throws ReplayForbiddenError      on 403
 * @throws ReplaySessionNotFoundError on 404
 * @throws ReplaySessionExpiredError  on 410
 * @throws ReplayInvalidSessionError  on 400
 */
export async function fetchSession(
  transport: Transport | undefined,
  sessionId: string,
): Promise<SessionResponse> {
  const baseUrl = resolveBaseUrl(transport);
  const path = sessionPath(sessionId);
  const url = `${baseUrl}${path}`;

  if (transport !== undefined) {
    // Use the transport's request() which handles auth headers, retries, logging.
    let resp: Awaited<ReturnType<Transport["request"]>>;
    try {
      resp = await transport.request<SessionResponse>("GET", path);
    } catch (err: unknown) {
      if (err !== null && typeof err === "object" && "statusCode" in err) {
        const e = err as { statusCode: number; message: string };
        switch (e.statusCode) {
          case 403:
            throw new ReplayForbiddenError(e.message, { statusCode: 403 });
          case 404:
            throw new ReplaySessionNotFoundError(e.message, { statusCode: 404 });
          case 410:
            throw new ReplaySessionExpiredError(e.message, { statusCode: 410 });
          case 400:
            throw new ReplayInvalidSessionError(e.message, { statusCode: 400 });
          default:
            throw err;
        }
      }
      throw err;
    }

    if (resp.body === null) {
      throw new ReplaySessionNotFoundError(`Session ${sessionId} returned empty body`, {
        statusCode: 404,
      });
    }
    return normalizeSessionResponse(resp.body as Record<string, unknown>, sessionId);
  }

  // No transport — bare fetch (test scenarios / framework adapters that mock fetch).
  let rawResp: Response;
  try {
    rawResp = await fetch(url);
  } catch (err: unknown) {
    throw new ReplaySessionNotFoundError(
      `Failed to fetch session ${sessionId}: ${String(err)}`,
      { statusCode: 0 },
    );
  }

  const status = rawResp.status;
  const bodyText = await rawResp.text();

  if (!rawResp.ok) {
    let message = bodyText;
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const detail = parsed.detail as Record<string, unknown> | undefined;
      message = (detail?.message as string | undefined) ?? bodyText;
    } catch {
      // leave message as raw text
    }
    switch (status) {
      case 403:
        throw new ReplayForbiddenError(message, { statusCode: 403 });
      case 404:
        throw new ReplaySessionNotFoundError(message, { statusCode: 404 });
      case 410:
        throw new ReplaySessionExpiredError(message, { statusCode: 410 });
      case 400:
        throw new ReplayInvalidSessionError(message, { statusCode: 400 });
      default:
        throw new ReplaySessionNotFoundError(message, { statusCode: status });
    }
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new ReplaySessionNotFoundError(
      `Session ${sessionId} returned non-JSON body`,
      { statusCode: 200 },
    );
  }

  return normalizeSessionResponse(raw, sessionId);
}

/**
 * Normalize camelCase fields from the server response into a SessionResponse.
 *
 * Tolerates either camelCase or snake_case keys (test fixtures still occasionally
 * use snake). Preserves `null` for the BE-Optional fields (`flowId`, `slug`,
 * `triggerType`, `traceCaptureMode`, `errorAtStep`) rather than coercing them
 * to defaults — the matcher needs `null` to trigger the `flowId` fallback path.
 */
function normalizeSessionResponse(
  raw: Record<string, unknown>,
  sessionId: string,
): SessionResponse {
  const executions = (raw.executions as unknown[] | undefined) ?? [];
  const normalizedExecutions = executions.map((ex): SessionResponse["executions"][number] => {
    const e = ex as Record<string, unknown>;
    const startedAt = (e.startedAt ?? e.started_at) as string | null | undefined;
    const completedAt = (e.completedAt ?? e.completed_at) as string | null | undefined;
    const errorAtStep = (e.errorAtStep ?? e.error_at_step) as string | null | undefined;
    const flowId = (e.flowId ?? e.flow_id) as string | null | undefined;
    const slug = e.slug as string | null | undefined;
    const triggerType = (e.triggerType ?? e.trigger_type) as
      | "execute" | "step" | "job" | null | undefined;
    const traceCaptureMode = (e.traceCaptureMode ?? e.trace_capture_mode) as
      | "full" | "redacted" | "metadata_only" | "off" | null | undefined;
    return {
      executionId: (e.executionId ?? e.execution_id ?? "") as string,
      ...(flowId !== undefined ? { flowId } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(triggerType !== undefined ? { triggerType } : {}),
      status: (e.status ?? "completed") as SessionResponse["executions"][number]["status"],
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(traceCaptureMode !== undefined ? { traceCaptureMode } : {}),
      snapshotsAvailable: (e.snapshotsAvailable ?? e.snapshots_available ?? true) as boolean,
      steps: (e.steps ?? []) as SessionResponse["executions"][number]["steps"],
      ...(errorAtStep !== undefined ? { errorAtStep } : {}),
    };
  });

  return {
    sessionId: (raw.sessionId ?? raw.session_id ?? sessionId) as string,
    executions: normalizedExecutions,
  };
}
