/**
 * Integration tests for Flow.steps() — step-by-step SSE streaming.
 *
 * Requires the two-step fixture (NOUKAI_INTEGRATION_TWO_STEP_SLUG).
 * Skipped by default. See tests/integration/README.md for setup.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Noukai, type StepCompleted } from "../../src/index.js";
import { integrationReady, makeClient, twoStepFlow, twoStepReady } from "./helpers.js";

// ---------------------------------------------------------------------------
// hello-world steps tests (need only integrationReady)
// ---------------------------------------------------------------------------

describe.skipIf(!integrationReady)("steps — hello-world fixture (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "yields at least one StepCompleted event",
    async () => {
      const steps: StepCompleted[] = [];

      for await (const step of client.flow(process.env.NOUKAI_INTEGRATION_HELLO_SLUG!).steps({
        message: "steps hello",
      })) {
        steps.push(step);
      }

      expect(steps.length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it(
    "each StepCompleted has a non-empty stepId",
    async () => {
      for await (const step of client.flow(process.env.NOUKAI_INTEGRATION_HELLO_SLUG!).steps({
        message: "step id check",
      })) {
        expect(step.stepId).toBeTruthy();
        expect(step.type).toBe("step_completed");
      }
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// two-step specific tests
// ---------------------------------------------------------------------------

describe.skipIf(!twoStepReady)("steps — two-step fixture (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "async for-await collects exactly 2 StepCompleted events",
    async () => {
      const steps: StepCompleted[] = [];

      for await (const step of twoStepFlow(client).steps({ message: "two step test" })) {
        steps.push(step);
      }

      expect(steps).toHaveLength(2);
      expect(steps[0]!.type).toBe("step_completed");
      expect(steps[1]!.type).toBe("step_completed");
    },
    90_000,
  );

  it(
    "step ids are distinct across both steps",
    async () => {
      const stepIds: string[] = [];

      for await (const step of twoStepFlow(client).steps({ message: "distinct ids" })) {
        stepIds.push(step.stepId);
      }

      expect(stepIds).toHaveLength(2);
      expect(new Set(stepIds).size).toBe(2);
    },
    90_000,
  );

  it(
    "StepCompleted events carry durationMs when the block is LLM-backed",
    async () => {
      for await (const step of twoStepFlow(client).steps({ message: "duration check" })) {
        // durationMs may be absent for instant steps, but LLM blocks always emit it.
        if (step.durationMs !== undefined) {
          expect(typeof step.durationMs).toBe("number");
          expect(step.durationMs).toBeGreaterThanOrEqual(0);
        }
      }
    },
    90_000,
  );

  it(
    "steps() with trace: true completes without error",
    async () => {
      const steps: StepCompleted[] = [];

      for await (const step of twoStepFlow(client).steps({
        message: "trace steps test",
        trace: true,
      })) {
        steps.push(step);
      }

      expect(steps.length).toBeGreaterThanOrEqual(1);
    },
    90_000,
  );
});
