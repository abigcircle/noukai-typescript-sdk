/**
 * Integration tests for the direct `messages[]` execute path (design F6).
 *
 * Exercises the chat/agent fixture (NOUKAI_INTEGRATION_AGENT_SLUG) over the
 * key-holding `flow.execute()` transport — proving that a structured
 * `messages[]` payload drives the same yield/resume tool-calling loop a single
 * `message` string does. Skipped by default. See tests/integration/README.md.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Noukai, type PausedResult } from "../../src/index.js";
import {
  agentFlow,
  agentReady,
  GET_WEATHER_TOOL,
  makeClient,
  weatherToolHandler,
} from "./helpers.js";

describe.skipIf(!agentReady)("messages[] (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  // -------------------------------------------------------------------------
  // Auto mode — messages[] + toolHandler
  // -------------------------------------------------------------------------

  it(
    "messages[] + toolHandler: the loop drives the tool call and completes",
    async () => {
      const result = await agentFlow(client).execute({
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [GET_WEATHER_TOOL],
        toolHandler: weatherToolHandler,
      });

      expect(result.status).toBe("completed");
      expect(result.requiresToolCalls).toBe(false);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // Manual mode — messages[] without a toolHandler → PausedResult → resume
  // -------------------------------------------------------------------------

  it(
    "messages[] without toolHandler: pauses with tool calls, then resume() completes",
    async () => {
      const paused = (await agentFlow(client).execute({
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [GET_WEATHER_TOOL],
        // No toolHandler — the SDK should pause and return a PausedResult.
      })) as PausedResult;

      expect(paused.status).toBe("tool_calls_required");
      expect(paused.requiresToolCalls).toBe(true);
      expect(paused.executionId).toBeTruthy();
      expect(paused.toolCalls.length).toBeGreaterThan(0);
      expect(typeof paused.resume).toBe("function");

      const resumed = await paused.resume({
        toolResults: weatherToolHandler(paused.toolCalls),
      });

      expect(resumed.status).toBe("completed");
      expect(resumed.requiresToolCalls).toBe(false);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // Regression guard — the single `message` string form still works
  // -------------------------------------------------------------------------

  it(
    "single `message` string still drives the tool call and completes",
    async () => {
      const result = await agentFlow(client).execute({
        message: "What is the weather in Paris?",
        tools: [GET_WEATHER_TOOL],
        toolHandler: weatherToolHandler,
      });

      expect(result.status).toBe("completed");
      expect(result.requiresToolCalls).toBe(false);
    },
    120_000,
  );
});
