export const DEFAULT_BASE_URL = "https://api.noukai.xyz/api/v1";
export const DEV_BASE_URL = "http://localhost:8080/api/v1";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_JOB_POLL_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_MAX_TOOL_ROUNDS = 10;

export const API_KEY_PREFIX = "nk_";
export const API_KEY_ENV_VAR = "NOUKAI_API_KEY";
export const ENV_ENV_VAR = "NOUKAI_ENV";

export const HEADER_API_VERSION = "X-Noukai-API-Version";
export const HEADER_REQUEST_ID = "X-Request-ID";
export const HEADER_USER_AGENT = "User-Agent";

export const HEADER_SESSION_ID = "X-Session-Id";
export const HEADER_REPLAY = "X-Noukai-Replay";
export const HEADER_RESPONSE_SESSION = "X-Noukai-Session";

export const REPLAY_ENABLED_ENV_VAR = "NOUKAI_REPLAY_ENABLED";

export const API_VERSION = "2026-05-31"; // matches Python SDK's pinned contract

/** Mirror of server's flow_run_trace.TraceEventType */
export const TraceEventType = {
  FLOW_STARTED: "flow_started",
  RUN_STARTED: "run_started",
  STEP_STARTED: "step_started",
  STEP_INPUT: "step_input",
  STEP_OUTPUT: "step_output",
  STEP_COMPLETED: "step_completed",
  STEP_ERROR: "step_error",
  STEP_PAUSED: "step_paused",
  STEP_PAUSED_FOR_TOOL_CALLS: "step_paused_for_tool_calls",
  STEP_PROGRESS: "step_progress",
  LOOP_COMPLETED: "loop_completed",
  FLOW_COMPLETED: "flow_completed",
} as const;
export type TraceEventTypeValue = (typeof TraceEventType)[keyof typeof TraceEventType];

/** Mirror of server's SeqflowExecuteErrorCode + SeqflowStepErrorCode union. Lands on NoukaiError.code. */
export const ServerErrorCode = {
  FLOW_NOT_FOUND: "FLOW_NOT_FOUND",
  INVALID_TREE: "INVALID_TREE",
  NO_STEPS: "NO_STEPS",
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  CREDITS_EXHAUSTED: "CREDITS_EXHAUSTED",
  BILLING_UNAVAILABLE: "BILLING_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // Tool-call
  TOOLS_NOT_ENABLED: "TOOLS_NOT_ENABLED",
  TOOLS_INVALID: "TOOLS_INVALID",
  TOOL_NAME_INVALID: "TOOL_NAME_INVALID",
  TOOLS_IN_NON_SEQUENTIAL_STEP: "TOOLS_IN_NON_SEQUENTIAL_STEP",
  PAUSED_STEP_INVALID: "PAUSED_STEP_INVALID",
  EXECUTION_ID_INVALID: "EXECUTION_ID_INVALID",
  TOOL_RESULTS_MISMATCH: "TOOL_RESULTS_MISMATCH",
  TOOL_ITERATION_LIMIT: "TOOL_ITERATION_LIMIT",
  MESSAGES_TOO_LARGE: "MESSAGES_TOO_LARGE",
  TOOLS_REQUIRE_SYNC_EXECUTE: "TOOLS_REQUIRE_SYNC_EXECUTE",
  // Step-specific
  INVALID_STEP_INDEX: "INVALID_STEP_INDEX",
  INVALID_FIRST_CALL: "INVALID_FIRST_CALL",
  STALE_TREE: "STALE_TREE",
  MISSING_MESSAGE: "MISSING_MESSAGE",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  // BYOK
  BYOK_KEY_REJECTED: "BYOK_KEY_REJECTED",
} as const;
export type ServerErrorCodeValue = (typeof ServerErrorCode)[keyof typeof ServerErrorCode];
