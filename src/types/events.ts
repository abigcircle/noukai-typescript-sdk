interface BaseEvent {
  type: string;
}

export interface RunStarted extends BaseEvent {
  type: "run_started" | "flow_started"; // legacy alias accepted
  runId: string;
  executionId?: string;
  flowId?: string;
  stepCount?: number;
}

export interface StepStarted extends BaseEvent {
  type: "step_started";
  stepId: string;
  name?: string;
  stepIndex?: number;
}

export interface StepInput extends BaseEvent {
  type: "step_input";
  stepId: string;
  inputData?: Record<string, unknown>;
}

export interface StepOutput extends BaseEvent {
  type: "step_output";
  stepId: string;
  outputData?: unknown;
}

export interface StepCompleted extends BaseEvent {
  type: "step_completed";
  stepId: string;
  name?: string;
  output?: unknown;
  durationMs?: number;
  tokens?: { prompt: number; completion: number; total: number };
  costUsd?: string;
}

export interface StepFailed extends BaseEvent {
  type: "step_error";
  stepId: string;
  name?: string;
  error?: Record<string, unknown>;
}

export interface StepPaused extends BaseEvent {
  type: "step_paused";
  stepId: string;
  stepIndex?: number;
}

/**
 * Step paused for tool calls. `.resume(...)` is attached at runtime when this
 * event is yielded by `flow.events()` (Phase 6).
 */
export interface ToolCallsRequired extends BaseEvent {
  type: "tool_calls_required";
  runId: string;
  executionId: string;
  stepId: string;
  stepIndex: number;
  iterationsUsed: number;
  toolCallMessages: Record<string, unknown>[];
  toolCalls: Record<string, unknown>[];
  accumulatedOutputs: Record<string, unknown>;
  resume(args: { toolResults: Record<string, unknown>[] }): Promise<void>;
}

export interface FlowCompleted extends BaseEvent {
  type: "flow_completed";
  runId?: string;
  executionId?: string;
  result?: unknown;
  summary?: Record<string, unknown>;
}

/** Discriminated union — switch on `event.type` for full TS narrowing. */
export type StreamEvent =
  | RunStarted
  | StepStarted
  | StepInput
  | StepOutput
  | StepCompleted
  | StepFailed
  | StepPaused
  | ToolCallsRequired
  | FlowCompleted;
