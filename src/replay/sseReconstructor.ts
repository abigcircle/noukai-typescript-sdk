/**
 * SSE event reconstructor for replay mode — Phase 7 implementation.
 *
 * Reconstructs the canonical SSE event sequence from a recorded
 * `SessionExecution`, emitting the same ordered event stream that a live
 * execution would have produced:
 *
 *   run_started
 *   for each step:
 *     step_started
 *     step_completed  (success) | step_error (failure) → flow_completed → return
 *   flow_completed
 *
 * Timing is instant — no inter-event delay (per design §Streaming replay).
 *
 * Per design 20260605-SDK-replay-decorator § Streaming, this is a pure
 * transformation: no I/O, no side-effects.
 */

import type {
  StreamEvent,
  RunStarted,
  StepStarted,
  StepCompleted,
  StepFailed,
  FlowCompleted,
} from "../types/events.js";
import type { SessionExecution } from "../types/session.js";
import { stripTraceSidecars } from "./snapshot.js";

/**
 * Reconstruct a stream of `StreamEvent`s from a recorded execution.
 *
 * Emits `run_started`, per-step `step_started` + `step_completed` (or
 * `step_error` on failure), and a terminal `flow_completed`.
 *
 * On step failure: emits `step_started` → `step_error` → `flow_completed`
 * (with `summary.failedAtStep` set) then returns early. The matcher layer
 * (Phase 6) is responsible for raising `FlowExecutionError` after the stream
 * completes if the execution had `errorAtStep` set.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function* reconstructEvents(
  ex: SessionExecution,
): AsyncIterable<StreamEvent> {
  // 1. run_started — once at execution start. flowId may be null/undefined
  // when the BE has lost track of the underlying flow (e.g. deleted) — coerce
  // to "" so the event still satisfies the RunStarted shape. Consistent with
  // materializeExecuteResult's flowId fallback.
  const runStarted: RunStarted = {
    type: "run_started",
    runId: ex.executionId,
    executionId: ex.executionId,
    flowId: ex.flowId ?? "",
    stepCount: ex.steps.length,
  };
  yield runStarted;

  // 2. Per-step events — ordered by startedAt ASC (trust wire order from BE).
  //    `stepIndex` is stamped here so the replay path produces the same
  //    flow-absolute, consumer-frame contract as the live EventIterator
  //    (see src/types/events.ts for the SDK guarantee).
  let stepIndex = 0;
  for (const step of ex.steps) {
    const started: StepStarted = {
      type: "step_started",
      stepId: step.stepId,
      stepIndex,
    };
    yield started;

    if (step.errorSnapshot != null) {
      // Step-level failure: emit step_error then a terminal flow_completed
      // with a failure summary, then stop.
      const failed: StepFailed = {
        type: "step_error",
        stepId: step.stepId,
        error: step.errorSnapshot,
      };
      yield failed;

      const failedTerminal: FlowCompleted = {
        type: "flow_completed",
        executionId: ex.executionId,
        result: undefined,
        summary: { failedAtStep: step.stepId },
      };
      yield failedTerminal;
      return;
    }

    // Normal step completion.
    const completed: StepCompleted = {
      type: "step_completed",
      stepId: step.stepId,
      // Strip reserved trace sidecars so the replayed output matches the live
      // step_completed output, which excludes them.
      output: stripTraceSidecars(step.outputSnapshot),
      stepIndex,
      // step.name / tokens / costUsd are not stored in snapshots — left unset.
    };
    yield completed;
    stepIndex++;
  }

  // 3. Terminal flow_completed (success path).
  const lastStep = ex.steps[ex.steps.length - 1];
  const terminal: FlowCompleted = {
    type: "flow_completed",
    executionId: ex.executionId,
    result: stripTraceSidecars(lastStep?.outputSnapshot),
  };
  yield terminal;
}
