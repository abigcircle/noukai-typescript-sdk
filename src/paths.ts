/**
 * Centralized backend URL paths for the Noukai SDK.
 *
 * SINGLE SOURCE OF TRUTH for every wire path the SDK calls. This file exists
 * so an auditor can read one place to verify the SDK matches the backend
 * route registrations. If a route changes server-side, change this file —
 * every call site updates automatically.
 *
 * Backend handler references (router-ai-slugs):
 *   - `/seq/{org}/{project}/{slug}/execute`   — seqflow_routes.py POST
 *   - `/seq/{org}/{project}/{slug}/step`      — seqflow_routes.py POST
 *   - `/seq/{org}/{project}/{slug}/jobs`      — seqflow_routes.py POST (queue)
 *   - `/seq/{org}/{project}/{slug}/jobs/{id}` — jobs_routes.py     GET
 *   - `/seq/{org}/{project}/{slug}/runs/{id}` — runs_routes.py     GET / sub
 *   - `/seq/sessions/{session_id}`            — sessions_routes.py GET
 *
 * Audit note: the BE routers all mount under `APIRouter(prefix="/seq")`;
 * paths here include that prefix. If a router renames its prefix, update
 * `SEQ_PREFIX` below and all consumers will pick it up.
 */

import { ReplayInvalidSessionError } from "./errors.js";

/** Common backend prefix for all seqflow routes. */
const SEQ_PREFIX = "/seq";

/**
 * Session IDs are server-generated UUIDs. Accepting any other shape would
 * let attacker-controlled values (e.g. from the `X-Noukai-Replay` header
 * read by replay middleware) inject `/`, `..`, or `?` into the URL path and
 * pivot the authenticated GET to a different endpoint under the same API
 * base.
 */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// Versioned flow base (org/project/slug, optionally pinned to /v{N})
// ---------------------------------------------------------------------------

export type VersionSegment = "draft" | number;

/**
 * Build the versioned base path for a flow.
 *
 * - `"draft"`  → `/seq/{org}/{project}/{slug}`
 * - `<int>`    → `/seq/{org}/{project}/{slug}/v{N}`
 *
 * `"production"` is intentionally unsupported here — callers must reject it
 * before reaching this helper (server-side body-field routing not deployed).
 */
export function flowBase(
  org: string,
  project: string,
  slug: string,
  version: VersionSegment = "draft",
): string {
  const base = `${SEQ_PREFIX}/${org}/${project}/${slug}`;
  return typeof version === "number" ? `${base}/v${String(version)}` : base;
}

// ---------------------------------------------------------------------------
// Flow execution endpoints
// ---------------------------------------------------------------------------

/** `POST /seq/{org}/{project}/{slug}[/vN]/execute` — synchronous execute. */
export function flowExecutePath(
  org: string,
  project: string,
  slug: string,
  version: VersionSegment = "draft",
): string {
  return `${flowBase(org, project, slug, version)}/execute`;
}

/** `POST /seq/{org}/{project}/{slug}[/vN]/step` — SSE step stream. */
export function flowStepPath(
  org: string,
  project: string,
  slug: string,
  version: VersionSegment = "draft",
): string {
  return `${flowBase(org, project, slug, version)}/step`;
}

/** `POST /seq/{org}/{project}/{slug}[/vN]/jobs` — queue-backed execute submission. */
export function flowJobsSubmitPath(
  org: string,
  project: string,
  slug: string,
  version: VersionSegment = "draft",
): string {
  return `${flowBase(org, project, slug, version)}/jobs`;
}

/** `GET /seq/{org}/{project}/{slug}/jobs/{executionId}` — poll a queued job. */
export function flowJobPollPath(
  org: string,
  project: string,
  slug: string,
  executionId: string,
): string {
  return `${flowBase(org, project, slug)}/jobs/${executionId}`;
}

// ---------------------------------------------------------------------------
// Run trace endpoints
// ---------------------------------------------------------------------------

/** `GET /seq/{org}/{project}/{slug}/runs/{executionId}` — run summary. */
export function runPath(
  org: string,
  project: string,
  slug: string,
  executionId: string,
): string {
  return `${flowBase(org, project, slug)}/runs/${executionId}`;
}

// ---------------------------------------------------------------------------
// Session replay endpoint
// ---------------------------------------------------------------------------

/**
 * `GET /seq/sessions/{sessionId}` — replay cassette fetch.
 *
 * Backend: `router-ai-slugs/api/sessions_routes.py`.
 * Design: `20260605-BE-execution-session-grouping`.
 * The route is NOT scoped by org/project — auth is per-flow-run inside the
 * handler.
 *
 * `sessionId` is validated as a UUID before interpolation. Replay middleware
 * reads it from an attacker-controllable HTTP header; rejecting non-UUID
 * shapes here prevents path traversal into other authenticated endpoints.
 * The segment is also URL-encoded as a backstop.
 */
export function sessionPath(sessionId: string): string {
  if (!UUID_RE.test(sessionId)) {
    throw new ReplayInvalidSessionError(
      `Invalid session id format (expected UUID): ${JSON.stringify(sessionId)}`,
      { statusCode: 400 },
    );
  }
  return `${SEQ_PREFIX}/sessions/${encodeURIComponent(sessionId)}`;
}
