/**
 * Integration tests for the keyless agent relay (design 20260903-SDK-agent-relay).
 *
 * The main event: a REAL ephemeral Express server whose only route is the
 * `noukaiRelayHandler` (holding the live `nk_` key), fronted by a keyless
 * `createRelayFlow` that drives the tool-calling loop. Proves the full
 * round-trip — the browser-side loop POSTs keyless to the relay, the relay
 * injects the key and forwards to the real dev server, and pause/resume flows
 * back through the same relay transport automatically.
 *
 * Skipped by default unless the chat/agent fixture is configured
 * (NOUKAI_INTEGRATION_AGENT_SLUG). See tests/integration/README.md.
 *
 * NOTE: the relay route is mounted WITHOUT a JSON body parser — the handler
 * reads the raw request bytes and bounds them before parse; a body parser would
 * drain the stream and defeat byte-bounding.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRelayFlow,
  FlowExecutionError,
  NoukaiError,
  PermissionDeniedError,
  type Noukai,
  type PausedResult,
} from "../../src/index.js";
import { noukaiRelayHandler, type RelayExpressRequest } from "../../src/adapters/express.js";
import {
  AGENT_SLUG,
  agentReady,
  GET_WEATHER_TOOL,
  INTEGRATION_PROJECT,
  makeClient,
  weatherToolHandler,
} from "./helpers.js";

describe.skipIf(!agentReady)("agent relay round-trip (integration)", () => {
  // Every server + client started by a test is torn down in afterEach.
  const servers: Server[] = [];
  const clients: Noukai[] = [];

  /**
   * Spin up a real ephemeral relay server on a random port and return its URL.
   * The relay's `client` holds the real nk_ key; `authorize` defaults to allow.
   */
  async function startRelay(opts: {
    authorize?: (req: RelayExpressRequest) => void | Promise<void>;
    bounds?: { maxBodyBytes?: number; maxMessages?: number };
  } = {}): Promise<string> {
    const client = makeClient();
    clients.push(client);

    // Resolve coords here, not in the describe body: vitest runs the suite
    // callback at collection even when skipIf skips it, so touching
    // INTEGRATION_PROJECT / AGENT_SLUG at that level throws when the integration
    // env is absent (e.g. CI). startRelay only runs inside a non-skipped test.
    const [org, project] = INTEGRATION_PROJECT!.split("/", 2) as [string, string];
    const slug = AGENT_SLUG!;

    const app = express();
    // Deliberately no express.json() — the relay reads the raw body itself.
    app.post(
      "/agent/execute",
      noukaiRelayHandler({
        client,
        org,
        project,
        slug,
        authorize: opts.authorize ?? ((): Promise<void> => Promise.resolve()),
        ...(opts.bounds !== undefined ? { bounds: opts.bounds } : {}),
      }),
    );

    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => {
        resolve(s);
      });
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${String(port)}/agent/execute`;
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) => new Promise<void>((resolve) => { s.close(() => { resolve(); }); }),
      ),
    );
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  // -------------------------------------------------------------------------
  // 1. Happy path — auto tool loop over the relay completes
  // -------------------------------------------------------------------------

  it(
    "auto tool loop over the relay completes",
    async () => {
      const url = await startRelay();
      const result = await createRelayFlow({ url }).execute({
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
  // 2. Paused → resume flows back through the SAME relay transport
  // -------------------------------------------------------------------------

  it(
    "pauses without a toolHandler, then resume() routes back through the relay and completes",
    async () => {
      const url = await startRelay();

      // Count POSTs to the relay to prove BOTH the fresh call and the resume
      // travel over the relay transport (not some direct back-channel).
      let relayCalls = 0;
      const countingFetch: typeof fetch = (input, init) => {
        relayCalls++;
        return fetch(input, init);
      };

      const flow = createRelayFlow({ url, fetch: countingFetch });
      const paused = (await flow.execute({
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [GET_WEATHER_TOOL],
        // No toolHandler — expect a PausedResult we drive manually.
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
      // Fresh call + at least one resume, both over the relay.
      expect(relayCalls).toBeGreaterThanOrEqual(2);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 3. The client→relay leg carries NO auth header (the relay injects it)
  // -------------------------------------------------------------------------

  it(
    "sends no Authorization header on the client→relay leg yet still completes",
    async () => {
      const url = await startRelay();

      const authHeaders: (string | null)[] = [];
      const capturingFetch: typeof fetch = (input, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return fetch(input, init);
      };

      const result = await createRelayFlow({ url, fetch: capturingFetch }).execute({
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [GET_WEATHER_TOOL],
        toolHandler: weatherToolHandler,
      });

      expect(result.status).toBe("completed");
      // createRelayFlow is keyless: no leg to the relay may carry an nk_ bearer.
      expect(authHeaders.length).toBeGreaterThan(0);
      expect(authHeaders.every((h) => h === null)).toBe(true);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 4. authorize rejection → the loop surfaces a typed 403
  // -------------------------------------------------------------------------

  it(
    "authorize rejection surfaces as PermissionDeniedError (403)",
    async () => {
      const url = await startRelay({
        // Throw with a numeric status — the relay honors it (message never echoed).
        authorize: () => {
          throw Object.assign(new Error("internal: not a maker"), { status: 403 });
        },
      });

      const err: unknown = await createRelayFlow({ url })
        .execute({
          messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
          tools: [GET_WEATHER_TOOL],
          toolHandler: weatherToolHandler,
        })
        .then(
          () => {
            throw new Error("expected the relay to reject with 403");
          },
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect((err as NoukaiError).statusCode).toBe(403);
      // The internal Error.message must never cross the relay to the client.
      expect((err as NoukaiError).message).not.toContain("not a maker");
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 5. Body bound → the relay returns 413 before forwarding
  // -------------------------------------------------------------------------

  it(
    "a tiny maxBodyBytes bound rejects with a typed 413 before forwarding",
    async () => {
      const url = await startRelay({ bounds: { maxBodyBytes: 10 } });

      const err: unknown = await createRelayFlow({ url })
        .execute({
          messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
          tools: [GET_WEATHER_TOOL],
          toolHandler: weatherToolHandler,
        })
        .then(
          () => {
            throw new Error("expected the relay to reject oversized body with 413");
          },
          (e: unknown) => e,
        );

      // 413 is not specially mapped, so it surfaces as the generic FlowExecutionError.
      expect(err).toBeInstanceOf(NoukaiError);
      expect(err).toBeInstanceOf(FlowExecutionError);
      expect((err as NoukaiError).statusCode).toBe(413);
    },
    120_000,
  );
});
