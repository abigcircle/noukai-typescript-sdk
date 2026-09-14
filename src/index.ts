export { VERSION } from "./version.js";

// Clients
export { Noukai, type NoukaiOptions } from "./client.js";

// Proxies
export { Flow } from "./flow.js";
export { Run } from "./run.js";
export { Job } from "./job.js";

// Keyless relay entrypoint (agent-over-relay — design 20260903-SDK-agent-relay)
export {
  createRelayFlow,
  RelayFlow,
  type CreateRelayFlowOptions,
  type RelayExecuteOptions,
} from "./relay-flow.js";
export {
  RelayExecuteTransport,
  type ExecuteTransport,
  type RelayExecuteTransportOptions,
} from "./tool-calls.js";

// Result types
export type {
  ExecuteResult,
  PausedResult,
  JobAccepted,
  JobStatus,
} from "./types/responses.js";

// Request types (exported for users building helpers)
export type { ChatMessage, ExecuteRequest, StepRequest } from "./types/requests.js";

// Events
export type {
  StreamEvent,
  RunStarted,
  StepStarted,
  StepInput,
  StepOutput,
  StepCompleted,
  StepFailed,
  StepPaused,
  ToolCallsRequired,
  FlowCompleted,
} from "./types/events.js";

// Trace
export type {
  Trace,
  RunSummary,
  StepTrace,
  StepAttempts,
  TokenBreakdown,
} from "./types/trace.js";

// Errors
export {
  NoukaiError,
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  PermissionDeniedError,
  FlowNotFoundError,
  InsufficientCreditsError,
  RateLimitError,
  FlowExecutionError,
  ToolCallLimitError,
  // Replay errors (Phase 1)
  ReplayError,
  ReplayDisabledError,
  ReplayInvalidSessionError,
  ReplayForbiddenError,
  ReplaySessionNotFoundError,
  ReplaySessionExpiredError,
  ReplayNoSnapshotsError,
  ReplayMissError,
  ReplayLeftoverError,
} from "./errors.js";

// Constants (selective)
export { ServerErrorCode, type ServerErrorCodeValue } from "./constants.js";

// Replay scope (Phase 2 skeletons — bodies implemented in Phase 4+)
export { traceScope, currentSessionId, currentScope, type TraceScopeOptions } from "./replay/scope.js";
