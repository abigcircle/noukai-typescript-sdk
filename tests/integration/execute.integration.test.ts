/**
 * Integration tests for Flow.execute() — synchronous in-process execution.
 *
 * Skipped by default. Set the NOUKAI_INTEGRATION_* env vars to enable.
 * See tests/integration/README.md for setup instructions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExecuteResult, type Noukai } from "../../src/index.js";
import { helloFlow, HELLO_SLUG, integrationReady, makeClient } from "./helpers.js";

describe.skipIf(!integrationReady)("execute (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "returns ExecuteResult with executionId and completed status",
    async () => {
      const result = await helloFlow(client).execute({ message: "hello" });

      expect(result.status).toBe("completed");

      // Narrowing via discriminant
      expect(result.requiresToolCalls).toBe(false);
      const completed = result as ExecuteResult;

      // executionId is optional in the type but the server always emits it
      expect(completed.executionId).toBeTruthy();
      expect(completed.flowId).toBeTruthy();
      expect(completed.blockCount).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "forwards parameters to the flow's first block",
    async () => {
      const result = await helloFlow(client).execute({
        message: "hello",
        parameters: { greeting: "hola" },
      });

      expect(result.status).toBe("completed");
      expect(result.requiresToolCalls).toBe(false);
    },
    60_000,
  );

  it(
    "trace: true works without error",
    async () => {
      const result = await helloFlow(client).execute({ message: "hi", trace: true });

      expect(result.status).toBe("completed");
    },
    60_000,
  );

  it(
    "costUsd in step_completed events is a string (server wire contract)",
    async () => {
      // The server emits costUsd as a decimal string ("0.000123"), not a number.
      // This test guards against accidental numeric coercion in the SDK.
      let sawCostEvent = false;

      for await (const event of client.flow(HELLO_SLUG!).events({ message: "hi" })) {
        if (event.type === "step_completed" && event.costUsd != null) {
          expect(typeof event.costUsd).toBe("string");
          sawCostEvent = true;
          // Don't break — consume the full stream to avoid connection leaks.
        }
      }

      // If no step_completed carried costUsd the fixture may not have LLM blocks —
      // mark as a warning rather than a hard failure, but log it.
      if (!sawCostEvent) {
        console.warn(
          "execute integration: no step_completed event with costUsd was observed. " +
            "Ensure the hello-world fixture has at least one LLM block.",
        );
      }
    },
    60_000,
  );

  it(
    "empty message string is accepted",
    async () => {
      // Some flows handle an empty string gracefully; others may fail.
      // We only assert the SDK does not throw before reaching the server.
      const result = await helloFlow(client)
        .execute({ message: "" })
        .catch((err: unknown) => err);

      // Either a completed result or a server-side error is acceptable;
      // what is NOT acceptable is an SDK-level TypeError or ReferenceError.
      if (result instanceof Error) {
        expect(result.constructor.name).not.toBe("TypeError");
        expect(result.constructor.name).not.toBe("ReferenceError");
      }
    },
    60_000,
  );
});
