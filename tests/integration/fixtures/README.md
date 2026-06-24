# Integration Test Fixtures

This directory holds JSON flow definitions used by the SDK integration test suite.
All three files are currently **placeholders** — the actual flows must be authored
via the `noukai-mcp` tools and then exported.

---

## Fixture overview

| File | Slug env var | Description |
|------|-------------|-------------|
| `hello-world.json` | `NOUKAI_INTEGRATION_HELLO_SLUG` | Single-step echo flow |
| `two-step.json` | `NOUKAI_INTEGRATION_TWO_STEP_SLUG` | Two-step sequential flow |
| `tools-enabled.json` | `NOUKAI_INTEGRATION_TOOLS_SLUG` | Tool-use enabled flow |

---

## hello-world

**Input:** `{ "message": "<any string>" }`  
**Output:** The same string, possibly slightly rephrased by an LLM block.  
**Used by:** `execute.integration.test.ts`, `execute-async.integration.test.ts`,
`errors.integration.test.ts`

Minimum requirements:
- Exactly one LLM block
- Block reads from `{{initial.message}}`
- Block produces a string output
- Produces `step_completed` events with `tokens` and `costUsd` fields populated

---

## two-step

**Input:** `{ "message": "<any string>" }`  
**Output:** A summary produced by the second block.  
**Used by:** `steps.integration.test.ts`, `events.integration.test.ts`

Minimum requirements:
- Exactly two sequential LLM blocks
- First block reads `{{initial.message}}`; second block reads the first block's output
- Both blocks produce `step_completed` events with token counts
- Flow does NOT pause between steps when `runRemaining: true`

---

## tools-enabled

**Input:** `{ "message": "<any string>" }`  
**Output:** A string that incorporates the result of a `get_weather` tool call.  
**Used by:** `tool-calls.integration.test.ts`

Minimum requirements:
- One LLM block with tools enabled
- Tool named `get_weather` with parameters `{ "location": "string" }`
- Block will call `get_weather` at least once per run
- Block will keep calling tools if the previous result says "try again" (used to
  test `maxToolRounds` limit)

---

## How to author fixtures

1. Open Claude Code and connect the `noukai-mcp` server.
2. Use `create_flow` to create a new draft flow in your fixture project.
3. Use `add_block` / `add_edge` to add the required blocks.
4. Use `hydrate_project` (or the equivalent export tool) to download the flow JSON.
5. Replace the placeholder content in the relevant `.json` file with the exported JSON.
6. Test by setting the env vars and running `pnpm test:integration`.

See `tests/integration/README.md` for the full environment variable setup guide.
