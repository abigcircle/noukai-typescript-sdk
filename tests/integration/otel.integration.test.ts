/**
 * Integration tests: opt-in customer-side OpenTelemetry (design
 * 20260916-SDK-otel-and-replay-rename).
 *
 * The parent-span test runs against a live flow today. The per-block step-span
 * test needs the slug-scoped `run.trace()` endpoint — the same server prereq as
 * run-proxy.integration.test.ts — so it is gated on `NOUKAI_RUN_PROXY_TESTS`;
 * flip that env var to `true` once the endpoint is deployed.
 */

import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Tracer } from "@opentelemetry/api";

import { Noukai } from "../../src/index.js";
import { HELLO_SLUG, INTEGRATION_KEY, INTEGRATION_PROJECT, integrationReady } from "./helpers.js";

const SERVER_PREREQ_DONE = process.env.NOUKAI_RUN_PROXY_TESTS === "true";

function tracing(): { exporter: InMemorySpanExporter; tracer: Tracer } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: provider.getTracer("integration") };
}

function otelClient(tracer: Tracer, opts: { steps?: boolean; payloads?: boolean } = {}): Noukai {
  const [org, project] = INTEGRATION_PROJECT!.split("/", 2) as [string, string];
  return new Noukai({
    apiKey: INTEGRATION_KEY!,
    org,
    project,
    env: (process.env.NOUKAI_ENV as "dev" | "production" | undefined) ?? "production",
    otel: true,
    tracer,
    ...(opts.steps ? { otelSteps: true } : {}),
    ...(opts.payloads ? { otelStepPayloads: true } : {}),
  });
}

describe.skipIf(!integrationReady)("OpenTelemetry — parent span (integration)", () => {
  it("emits a CLIENT span for a live execute()", async () => {
    const { exporter, tracer } = tracing();
    const noukai = otelClient(tracer);
    const result = await noukai.flow(HELLO_SLUG!).execute({ message: "otel parent span" });
    await noukai.close();

    const spans = exporter.getFinishedSpans().filter((s) => s.name === "noukai.flow.execute");
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["noukai.flow.slug"]).toBe(HELLO_SLUG);
    expect(spans[0].attributes["noukai.execution_id"]).toBe(
      (result as { executionId?: string }).executionId,
    );
    expect(spans[0].attributes["noukai.flow.status"]).toBe("completed");
  }, 60_000);
});

describe.skipIf(!SERVER_PREREQ_DONE || !integrationReady)(
  "OpenTelemetry — per-block child spans (integration)",
  () => {
    it("fetches run.trace() and emits one child span per block with data", async () => {
      const { exporter, tracer } = tracing();
      const noukai = otelClient(tracer, { steps: true, payloads: true });
      await noukai.flow(HELLO_SLUG!).execute({ message: "otel step spans" });
      await noukai.close();

      const children = exporter.getFinishedSpans().filter((s) => s.name === "noukai.flow.step");
      expect(children.length).toBeGreaterThanOrEqual(1);
      for (const child of children) {
        expect(child.attributes["noukai.step.id"]).toBeDefined();
        expect(child.attributes["noukai.step.status"]).toBeDefined();
      }
    }, 60_000);
  },
);
