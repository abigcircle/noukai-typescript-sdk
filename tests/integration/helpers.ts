/**
 * Shared setup helpers for the Noukai Node SDK integration test suite.
 *
 * Tests are skipped by default via `describe.skipIf` unless the required
 * NOUKAI_INTEGRATION_* env vars are set. No real network calls are made
 * unless those vars are present.
 */

import { Noukai, type Flow } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Environment variable constants
// ---------------------------------------------------------------------------

/** API key for the fixture project (must start with `nk_`). */
export const INTEGRATION_KEY = process.env.NOUKAI_INTEGRATION_KEY;

/**
 * Fixture project in `"org/project"` format.
 *
 * Example: `"acme/sdk-test-fixtures"`
 */
export const INTEGRATION_PROJECT = process.env.NOUKAI_INTEGRATION_PROJECT;

/** Slug of the hello-world fixture flow. */
export const HELLO_SLUG = process.env.NOUKAI_INTEGRATION_HELLO_SLUG;

/** Slug of the two-step fixture flow. */
export const TWO_STEP_SLUG = process.env.NOUKAI_INTEGRATION_TWO_STEP_SLUG;

/** Slug of the tools-enabled fixture flow. */
export const TOOLS_SLUG = process.env.NOUKAI_INTEGRATION_TOOLS_SLUG;

/**
 * Slug of the chat/agent fixture flow (`kind=chat`, tools enabled, accepts
 * `messages[]`). Used by `messages.integration.test.ts` and
 * `relay.integration.test.ts`.
 */
export const AGENT_SLUG = process.env.NOUKAI_INTEGRATION_AGENT_SLUG;

// ---------------------------------------------------------------------------
// Skip-if conditions
// ---------------------------------------------------------------------------

/**
 * True when the minimum env is set to run any integration test.
 *
 * Requires:
 *   - NOUKAI_INTEGRATION_KEY — a valid `nk_*` API key
 *   - NOUKAI_INTEGRATION_PROJECT — `"org/project"` (must contain `/`)
 *   - NOUKAI_INTEGRATION_HELLO_SLUG — slug for the hello-world fixture
 */
export const integrationReady: boolean =
  !!INTEGRATION_KEY &&
  !!INTEGRATION_PROJECT &&
  INTEGRATION_PROJECT.includes("/") &&
  !!HELLO_SLUG;

/**
 * True when integration is ready AND the tools-enabled fixture is configured.
 * Used by `tool-calls.integration.test.ts`.
 */
export const toolsReady: boolean = integrationReady && !!TOOLS_SLUG;

/**
 * True when integration is ready AND the two-step fixture is configured.
 * Used by `steps.integration.test.ts` and `events.integration.test.ts`.
 */
export const twoStepReady: boolean = integrationReady && !!TWO_STEP_SLUG;

/**
 * True when integration is ready AND the chat/agent fixture is configured.
 * Used by `messages.integration.test.ts` and `relay.integration.test.ts`.
 */
export const agentReady: boolean = integrationReady && !!AGENT_SLUG;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Construct a Noukai client from the integration env vars.
 *
 * Only call this from inside a `describe.skipIf(!integrationReady)` block —
 * it will throw if the env vars are not set.
 */
export function makeClient(): Noukai {
  // These are only called from inside describe.skipIf(!integrationReady) blocks,
  // so the non-null assertions are safe — we assert the vars exist in integrationReady.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [org, project] = INTEGRATION_PROJECT!.split("/", 2) as [string, string];
  return new Noukai({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    apiKey: INTEGRATION_KEY!,
    org,
    project,
    // Point at dev server when NOUKAI_ENV=dev, otherwise production.
    env: (process.env.NOUKAI_ENV as "dev" | "production" | undefined) ?? "production",
  });
}

/**
 * Return a Flow proxy for the hello-world fixture.
 *
 * Only call this from inside a `describe.skipIf(!integrationReady)` block.
 */
export function helloFlow(client: Noukai): Flow {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return client.flow(HELLO_SLUG!);
}

/**
 * Return a Flow proxy for the two-step fixture.
 *
 * Only call this from inside a `describe.skipIf(!twoStepReady)` block.
 */
export function twoStepFlow(client: Noukai): Flow {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return client.flow(TWO_STEP_SLUG!);
}

/**
 * Return a Flow proxy for the tools-enabled fixture.
 *
 * Only call this from inside a `describe.skipIf(!toolsReady)` block.
 */
export function toolsFlow(client: Noukai): Flow {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return client.flow(TOOLS_SLUG!);
}

/**
 * Return a Flow proxy for the chat/agent fixture (`messages[]` + tools).
 *
 * Only call this from inside a `describe.skipIf(!agentReady)` block.
 */
export function agentFlow(client: Noukai): Flow {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return client.flow(AGENT_SLUG!);
}

// ---------------------------------------------------------------------------
// Minimal stub tool definition for tool-call tests
// ---------------------------------------------------------------------------

/** A minimal `get_weather` tool definition accepted by Noukai. */
export const GET_WEATHER_TOOL: Record<string, unknown> = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Return the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

/** A deterministic tool handler for `get_weather` that always succeeds. */
export function weatherToolHandler(
  toolCalls: Record<string, unknown>[],
): Record<string, unknown>[] {
  return toolCalls.map((call) => {
    const fn = call.function as { name: string; arguments: string } | undefined;
    const args = fn?.arguments ? (JSON.parse(fn.arguments) as { location?: string }) : {};
    return {
      toolCallId: (call as { id?: string }).id ?? "stub",
      role: "tool",
      content: `Weather in ${args.location ?? "unknown"}: sunny, 22°C`,
    };
  });
}
