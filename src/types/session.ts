/**
 * GET /seq/sessions/{session_id} response shape.
 *
 * Mirrors the BE response model in
 * `services/executor/router-ai-slugs/src/router_ai_slugs/models/session.py`.
 *
 * Wire format: camelCase. See BE design
 * `20260605-BE-execution-session-grouping`.
 *
 * IMPORTANT — these types must stay aligned with the BE serializer:
 *  - `slug` is the BARE flow slug (e.g. `"grade-3"`), not `org/project/slug`.
 *    Several fields are Optional because the BE may emit `null` for them
 *    (e.g. when the underlying flow has been deleted).
 *  - `status` includes `"pending"` and `"cancelled"` per the BE Literal.
 *  - `SessionStepSnapshot` carries `status`, `loopIndex`, `durationMs` on top
 *    of the snapshot fields.
 */

/** Per-step snapshot inside a session execution. Matches BE `SessionStep`. */
export interface SessionStepSnapshot {
  stepId: string;
  attempt: number;
  loopIndex?: number | null;
  /** Step-level status. Distinct from the parent execution status. */
  status: "running" | "completed" | "failed" | "skipped";
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  inputSnapshot?: Record<string, unknown> | null;
  outputSnapshot?: Record<string, unknown> | null;
  errorSnapshot?: Record<string, unknown> | null;
  truncated: boolean;
  /** Legacy field name — some older fixtures expose `blockId`. Tolerated for forward compat. */
  blockId?: string;
}

/**
 * One flow_run inside a session, with its per-step snapshots.
 *
 * Matches BE `SessionExecution`. Note that the BE makes several fields
 * Optional — the SDK matcher must tolerate `null`/missing values.
 */
export interface SessionExecution {
  executionId: string;
  /**
   * UUID of the flow. Optional in the BE schema (FlowRun.flow_id is non-null
   * in practice, but typed Optional in the domain model). Used as the matcher
   * fallback when `slug` is null (e.g. flow was deleted).
   */
  flowId?: string | null;
  /**
   * BARE `flow.slug` (e.g. `"grade-3"`). NO org/project prefix.
   * `null` when the underlying flow has been deleted — match by `flowId`
   * in that case.
   */
  slug?: string | null;
  /** How this run was triggered. `null` for legacy rows without a recorded trigger. */
  triggerType?: "execute" | "step" | "job" | null;
  /**
   * Run-level status. Mirrors the BE Literal `pending | running | completed |
   * failed | cancelled`. Forward-compat: tolerate unknown strings rather than
   * blowing up on validation.
   */
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | (string & {});
  startedAt?: string | null;
  completedAt?: string | null;
  /**
   * Resolved capture mode at write time. `null` if no steps were recorded
   * (so the BE could not derive a canonical mode).
   */
  traceCaptureMode?: "full" | "redacted" | "metadata_only" | "off" | (string & {}) | null;
  /**
   * True if the SDK can replay this execution from stored snapshots. False
   * when capture mode was `off` or `metadata_only`.
   */
  snapshotsAvailable: boolean;
  steps: SessionStepSnapshot[];
  errorAtStep?: string | null;
}

export interface SessionResponse {
  sessionId: string;
  executions: SessionExecution[];
}
