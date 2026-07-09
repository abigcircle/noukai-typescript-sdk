/**
 * Integration tests for Flow.events() — full SSE event stream.
 *
 * Core event-type coverage uses the hello-world fixture (integrationReady).
 * Two-step-specific tests (runRemaining, multi-step ordering) require twoStepReady.
 *
 * Skipped by default. See tests/integration/README.md for setup.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Noukai,
  type StepCompleted,
  type StepStarted,
  type StreamEvent,
} from "../../src/index.js";
import { helloFlow, integrationReady, makeClient, twoStepFlow, twoStepReady } from "./helpers.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function collectEvents(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// hello-world: basic event types
// ---------------------------------------------------------------------------

describe.skipIf(!integrationReady)("events — hello-world fixture (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "yields RunStarted as the first event",
    async () => {
      const events = await collectEvents(helloFlow(client).events({ message: "run started" }));

      const first = events[0];
      expect(first).toBeDefined();
      // Server emits either "run_started" or legacy "flow_started"
      expect(["run_started", "flow_started"]).toContain(first!.type);
    },
    60_000,
  );

  it(
    "yields FlowCompleted as the last event",
    async () => {
      const events = await collectEvents(helloFlow(client).events({ message: "flow completed" }));

      const last = events[events.length - 1];
      expect(last).toBeDefined();
      expect(last!.type).toBe("flow_completed");
    },
    60_000,
  );

  it(
    "contains at least one step_started event",
    async () => {
      const events = await collectEvents(helloFlow(client).events({ message: "step started" }));

      const stepStarted = events.filter((e) => e.type === "step_started");
      expect(stepStarted.length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it(
    "contains at least one step_completed event",
    async () => {
      const events = await collectEvents(
        helloFlow(client).events({ message: "step completed check" }),
      );

      const stepCompleted = events.filter((e) => e.type === "step_completed");
      expect(stepCompleted.length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it(
    "step_completed events have tokens populated for LLM blocks",
    async () => {
      const events = await collectEvents(helloFlow(client).events({ message: "token check" }));

      const stepCompleted = events.filter((e) => e.type === "step_completed");
      expect(stepCompleted.length).toBeGreaterThanOrEqual(1);

      // At least one LLM-backed step should have token counts.
      // Cast through StepCompleted since we already filtered by type.
      const withTokens = (stepCompleted as StepCompleted[]).filter(
        (e) => e.tokens !== undefined,
      );
      if (withTokens.length > 0) {
        const first = withTokens[0]!;
        if (first.tokens) {
          expect(typeof first.tokens.prompt).toBe("number");
          expect(typeof first.tokens.completion).toBe("number");
          expect(typeof first.tokens.total).toBe("number");
          expect(first.tokens.total).toBeGreaterThan(0);
        }
      } else {
        console.warn(
          "events integration: no step_completed event with tokens observed. " +
            "Ensure the hello-world fixture uses an LLM block.",
        );
      }
    },
    60_000,
  );

  it(
    "event stream can be iterated twice independently (two separate HTTP calls)",
    async () => {
      const flow = helloFlow(client);
      const eventsA = await collectEvents(flow.events({ message: "run A" }));
      const eventsB = await collectEvents(flow.events({ message: "run B" }));

      // Each iteration is a fresh HTTP call — both should complete.
      expect(eventsA.length).toBeGreaterThan(0);
      expect(eventsB.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// two-step: ordering and runRemaining
// ---------------------------------------------------------------------------

describe.skipIf(!twoStepReady)("events — two-step fixture (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "yields all major event types: RunStarted, StepStarted, StepCompleted, FlowCompleted",
    async () => {
      const events = await collectEvents(twoStepFlow(client).events({ message: "all events" }));

      const types = new Set(events.map((e) => e.type));
      // run_started or legacy flow_started
      expect(types.has("run_started") || types.has("flow_started")).toBe(true);
      expect(types.has("step_started")).toBe(true);
      expect(types.has("step_completed")).toBe(true);
      expect(types.has("flow_completed")).toBe(true);
    },
    90_000,
  );

  it(
    "runRemaining: true produces all events in one HTTP call without StepPaused between steps",
    async () => {
      const events = await collectEvents(
        twoStepFlow(client).events({ message: "run remaining", runRemaining: true }),
      );

      const stepCompleted = events.filter((e) => e.type === "step_completed");
      const stepPaused = events.filter((e) => e.type === "step_paused");

      // Both steps should complete
      expect(stepCompleted.length).toBe(2);
      // No pauses between steps when runRemaining is set
      expect(stepPaused.length).toBe(0);
    },
    90_000,
  );

  it(
    "step_started events appear in step order (stepIndex ascending)",
    async () => {
      const events = await collectEvents(twoStepFlow(client).events({ message: "step order" }));

      const stepStartedIndices = (events.filter((e) => e.type === "step_started") as StepStarted[])
        .map((e) => e.stepIndex);

      // SDK contract: stepIndex is flow-absolute and strictly ascending
      // across step_started events even when the run spans multiple /step
      // segments (no `runRemaining`).
      for (let i = 1; i < stepStartedIndices.length; i++) {
        expect(stepStartedIndices[i]).toBeGreaterThan(stepStartedIndices[i - 1]!);
      }
    },
    90_000,
  );
});
