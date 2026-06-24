/**
 * Integration tests for the Run proxy (trace / stepTrace / liveTrace).
 *
 * ALL TESTS IN THIS FILE ARE BLOCKED.
 *
 * The server must add slug-scoped endpoints that accept nk_* API keys:
 *
 *   GET  /seq/{org}/{project}/{slug}/runs/{executionId}/trace
 *   GET  /seq/{org}/{project}/{slug}/runs/{executionId}/trace/stream
 *   GET  /seq/{org}/{project}/{slug}/runs/{executionId}/steps/{stepId}/trace
 *
 * When those land, flip `SERVER_PREREQ_DONE = true` and these tests will
 * run automatically whenever NOUKAI_INTEGRATION_* env vars are set.
 *
 * Until then, the suite is statically skipped to keep CI green.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Noukai, type Trace } from "../../src/index.js";
import { helloFlow, integrationReady, makeClient, twoStepFlow, twoStepReady } from "./helpers.js";

// ---------------------------------------------------------------------------
// Flip this flag to `true` once the server-side prereqs are deployed.
//
// Implementation note: we derive the value from an env var check rather than a
// literal constant so that the ESLint no-unnecessary-condition rule does not
// flag the `!SERVER_PREREQ_DONE` expressions in the describe.skipIf calls.
// The env var NOUKAI_RUN_PROXY_TESTS is never set in CI — to unblock, change
// the right-hand side below to `true` and remove the env var guard.
// ---------------------------------------------------------------------------
const SERVER_PREREQ_DONE = process.env.NOUKAI_RUN_PROXY_TESTS === "true";

// ---------------------------------------------------------------------------
// run.trace() — full run trace
// ---------------------------------------------------------------------------

describe.skipIf(!SERVER_PREREQ_DONE || !integrationReady)(
  "run proxy — trace() (integration)",
  () => {
    let client: Noukai;

    beforeEach(() => {
      client = makeClient();
    });

    afterEach(async () => {
      await client.close();
    });

    it(
      "run.trace() returns a Trace with flowRun and steps",
      async () => {
        const flow = helloFlow(client);
        const result = await flow.execute({ message: "trace test" });

        // executionId is typed as optional but always present post-execution
        const executionId = (result as { executionId?: string }).executionId;
        expect(executionId).toBeTruthy();

        const trace: Trace = await flow.run(executionId!).trace();

        expect(trace.flowRun).toBeDefined();
        expect(trace.flowRun.id).toBeTruthy();
        expect(trace.steps).toBeDefined();
        expect(Array.isArray(trace.steps)).toBe(true);
        expect(trace.steps.length).toBeGreaterThan(0);
      },
      60_000,
    );

    it(
      "trace flowRun.status is 'completed' after a successful execute",
      async () => {
        const flow = helloFlow(client);
        const result = await flow.execute({ message: "status check" });
        const executionId = (result as { executionId?: string }).executionId!;

        const trace = await flow.run(executionId).trace();

        expect(trace.flowRun.status).toBe("completed");
      },
      60_000,
    );

    it(
      "trace steps carry stepId, status, and durationMs",
      async () => {
        const flow = helloFlow(client);
        const result = await flow.execute({ message: "step details" });
        const executionId = (result as { executionId?: string }).executionId!;

        const trace = await flow.run(executionId).trace();

        for (const step of trace.steps) {
          expect(step.stepId).toBeTruthy();
          expect(["running", "completed", "failed", "skipped"]).toContain(step.status);
          if (step.durationMs !== undefined) {
            expect(typeof step.durationMs).toBe("number");
          }
        }
      },
      60_000,
    );
  },
);

// ---------------------------------------------------------------------------
// run.stepTrace() — single step trace
// ---------------------------------------------------------------------------

describe.skipIf(!SERVER_PREREQ_DONE || !twoStepReady)(
  "run proxy — stepTrace() (integration)",
  () => {
    let client: Noukai;

    beforeEach(() => {
      client = makeClient();
    });

    afterEach(async () => {
      await client.close();
    });

    it(
      "run.stepTrace(stepId) returns a StepTrace with matching stepId",
      async () => {
        const flow = twoStepFlow(client);
        const result = await flow.execute({ message: "step trace test" });
        const executionId = (result as { executionId?: string }).executionId!;

        const trace = await flow.run(executionId).trace();
        expect(trace.steps.length).toBeGreaterThan(0);

        const firstStep = trace.steps[0]!;
        const stepTrace = await flow.run(executionId).stepTrace(firstStep.stepId);

        // Response is either StepTrace or StepAttempts (attempt=all)
        // The default "latest" should return a StepTrace
        if ("attempts" in stepTrace) {
          // StepAttempts — verify array
          expect(Array.isArray(stepTrace.attempts)).toBe(true);
        } else {
          // StepTrace
          expect(stepTrace.stepId).toBe(firstStep.stepId);
          expect(["running", "completed", "failed", "skipped"]).toContain(stepTrace.status);
        }
      },
      90_000,
    );

    it(
      "run.stepTrace(stepId, { attempt: 'all' }) returns StepAttempts",
      async () => {
        const flow = twoStepFlow(client);
        const result = await flow.execute({ message: "all attempts" });
        const executionId = (result as { executionId?: string }).executionId!;

        const trace = await flow.run(executionId).trace();
        const firstStepId = trace.steps[0]!.stepId;

        const stepAttempts = await flow.run(executionId).stepTrace(firstStepId, {
          attempt: "all",
        });

        expect("attempts" in stepAttempts).toBe(true);
        if ("attempts" in stepAttempts) {
          expect(Array.isArray(stepAttempts.attempts)).toBe(true);
          expect(stepAttempts.attempts.length).toBeGreaterThanOrEqual(1);
        }
      },
      90_000,
    );
  },
);

// ---------------------------------------------------------------------------
// run.liveTrace() — streaming replay
// ---------------------------------------------------------------------------

describe.skipIf(!SERVER_PREREQ_DONE || !integrationReady)(
  "run proxy — liveTrace() (integration)",
  () => {
    let client: Noukai;

    beforeEach(() => {
      client = makeClient();
    });

    afterEach(async () => {
      await client.close();
    });

    it(
      "liveTrace() yields events for a completed run (all at once since run is done)",
      async () => {
        const flow = helloFlow(client);
        const result = await flow.execute({ message: "live trace" });
        const executionId = (result as { executionId?: string }).executionId!;

        const events = [];
        for await (const event of flow.run(executionId).liveTrace()) {
          events.push(event);
        }

        expect(events.length).toBeGreaterThan(0);
        // Last event should be flow_completed
        const last = events[events.length - 1];
        expect(last?.type).toBe("flow_completed");
      },
      60_000,
    );

    it(
      "liveTrace() event stream is fully typed (no unknown event types leak through)",
      async () => {
        const flow = helloFlow(client);
        const result = await flow.execute({ message: "typed events" });
        const executionId = (result as { executionId?: string }).executionId!;

        const knownTypes = new Set([
          "run_started",
          "flow_started",
          "step_started",
          "step_input",
          "step_output",
          "step_completed",
          "step_error",
          "step_paused",
          "tool_calls_required",
          "flow_completed",
        ]);

        for await (const event of flow.run(executionId).liveTrace()) {
          expect(knownTypes.has(event.type)).toBe(true);
        }
      },
      60_000,
    );
  },
);
