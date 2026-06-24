/**
 * Integration tests for tool-call flows.
 *
 * Requires the tools-enabled fixture (NOUKAI_INTEGRATION_TOOLS_SLUG).
 * Skipped by default. See tests/integration/README.md for setup.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Noukai, type PausedResult, ToolCallLimitError } from "../../src/index.js";
import {
  GET_WEATHER_TOOL,
  makeClient,
  toolsFlow,
  toolsReady,
  weatherToolHandler,
} from "./helpers.js";

describe.skipIf(!toolsReady)("tool-calls (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  // -------------------------------------------------------------------------
  // Auto mode (toolHandler provided)
  // -------------------------------------------------------------------------

  it(
    "auto mode: toolHandler is invoked and the flow completes",
    async () => {
      const result = await toolsFlow(client).execute({
        message: "What is the weather in Tokyo?",
        tools: [GET_WEATHER_TOOL],
        toolHandler: weatherToolHandler,
      });

      expect(result.status).toBe("completed");
      expect(result.requiresToolCalls).toBe(false);
    },
    120_000,
  );

  it(
    "auto mode: async toolHandler (returns Promise) is awaited correctly",
    async () => {
      const asyncHandler = async (
        toolCalls: Record<string, unknown>[],
      ): Promise<Record<string, unknown>[]> => {
        // Simulate an async operation (e.g., a real API call)
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return weatherToolHandler(toolCalls);
      };

      const result = await toolsFlow(client).execute({
        message: "What is the weather in Berlin?",
        tools: [GET_WEATHER_TOOL],
        toolHandler: asyncHandler,
      });

      expect(result.status).toBe("completed");
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // Manual mode (no toolHandler)
  // -------------------------------------------------------------------------

  it(
    "manual mode: returns PausedResult when no toolHandler is provided",
    async () => {
      const result = await toolsFlow(client).execute({
        message: "What is the weather in Paris?",
        tools: [GET_WEATHER_TOOL],
        // No toolHandler — the SDK should pause and return PausedResult
      });

      expect(result.status).toBe("tool_calls_required");
      expect(result.requiresToolCalls).toBe(true);

      const paused = result as PausedResult;
      expect(paused.executionId).toBeTruthy();
      expect(paused.toolCalls.length).toBeGreaterThan(0);
      expect(typeof paused.resume).toBe("function");
    },
    60_000,
  );

  it(
    "manual mode: paused.resume() with tool results continues and completes the flow",
    async () => {
      // First call — get the paused state
      const paused = (await toolsFlow(client).execute({
        message: "What is the weather in Sydney?",
        tools: [GET_WEATHER_TOOL],
      })) as PausedResult;

      expect(paused.status).toBe("tool_calls_required");

      // Provide tool results and resume
      const toolResults = weatherToolHandler(paused.toolCalls);
      const resumed = await paused.resume({ toolResults });

      // Flow should now be complete (or may need another round for looping flows)
      expect(["completed", "tool_calls_required"]).toContain(resumed.status);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // Tool round limits
  // -------------------------------------------------------------------------

  it(
    "maxToolRounds: 1 against a tool-looping flow raises ToolCallLimitError",
    async () => {
      // `toolChoice: "required"` forces the model to emit a tool_calls
      // response on every turn — without it, the model can decide to stop
      // calling tools and the loop terminates naturally before the client
      // limit fires (observed regression: gpt-4-class models often refuse
      // to "keep calling" without a concrete reason). With "required" +
      // maxToolRounds: 1, the second tool_calls_required round must throw.
      await expect(
        toolsFlow(client).execute({
          message: "Use the get_weather tool to check the weather in Tokyo.",
          tools: [GET_WEATHER_TOOL],
          toolChoice: "required",
          toolHandler: (calls) => {
            return calls.map((call) => ({
              tool_call_id: (call as { id?: string }).id ?? "stub",
              role: "tool",
              content: "Temporary upstream error — retry the same call.",
            }));
          },
          maxToolRounds: 1,
        }),
      ).rejects.toThrow(ToolCallLimitError);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Events stream tool-call path
  // -------------------------------------------------------------------------

  it(
    "events() yields ToolCallsRequired event when no toolHandler is set",
    async () => {
      let sawToolCallsRequired = false;

      for await (const event of toolsFlow(client).events({
        message: "What is the weather in Rome?",
        tools: [GET_WEATHER_TOOL],
      })) {
        if (event.type === "tool_calls_required") {
          sawToolCallsRequired = true;
          expect(event.executionId).toBeTruthy();
          expect(event.toolCalls.length).toBeGreaterThan(0);
          expect(typeof event.resume).toBe("function");
          // Don't call resume — just verify the shape and break
          break;
        }
      }

      expect(sawToolCallsRequired).toBe(true);
    },
    60_000,
  );
});
