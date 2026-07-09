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
  /**
   * Flow-absolute, zero-based index of the step that is starting, expressed in
   * the consumer's frame (i.e. the position of the step within the entire
   * flow, regardless of how the underlying `/step` transport segmented the
   * run).
   *
   * SDK guarantee: this value is always stamped by the SDK before the event
   * is yielded to user code. The server emits `stepIndex` as a segment-local
   * index (always `0` per `/step` call) — the SDK normalises that into a
   * flow-absolute index so multi-segment runs (no `runRemaining`) and
   * single-segment runs (`runRemaining: true`) present the same monotonic
   * index sequence to consumers.
   */
  stepIndex: number;
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
  /**
   * Flow-absolute, zero-based index of the completed step in the consumer's
   * frame. Identical semantics to `StepStarted.stepIndex` — the SDK stamps
   * this before yielding so the index of the *completed* step (not the next
   * one) is reported.
   *
   * SDK guarantee: always present on events yielded by `Flow.steps()` /
   * `Flow.events()`.
   */
  stepIndex: number;
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
  /**
   * Flow-absolute, zero-based index of the step that just completed and for
   * which the iterator is now pausing between transport segments. (A
   * `step_paused` event is always preceded by `step_completed` for step `N`
   * — `step_paused.stepIndex === N`, matching the `step_completed` that
   * precedes it. The pause itself belongs to the just-completed step, not to
   * any subsequent step.)
   *
   * SDK guarantee: always stamped by the SDK before yielding.
   */
  stepIndex: number;
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
