import { describe, it, expect, beforeEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

import { Flow } from "../src/flow.js";
import { Noukai } from "../src/index.js";
import { NoopSpanFactory, makeSpanFactory, type SpanFactory } from "../src/otel.js";
import { NoukaiError } from "../src/errors.js";
import type { Transport } from "../src/transport.js";

/**
 * Opt-in customer-side OpenTelemetry (design 20260916-SDK-otel-and-replay-rename, PR-B).
 * Verifies the parent CLIENT span for execute/executeAsync, the no-op-when-off
 * path, and error recording.
 */

const COMPLETED_BODY = {
  status: "completed",
  result: { ok: true },
  flowId: "flow-1",
  blockCount: 2,
  executionId: "exec-123",
};

let exporter: InMemorySpanExporter;
let tracer: ReturnType<BasicTracerProvider["getTracer"]>;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  tracer = provider.getTracer("test");
});

const TRACE_BODY = {
  flowRun: { id: "exec-123", flowId: "flow-1", status: "completed", stepCount: 2 },
  steps: [
    {
      stepId: "block-a",
      attempt: 1,
      status: "completed",
      startedAt: "2026-09-16T00:00:00Z",
      completedAt: "2026-09-16T00:00:01Z",
      durationMs: 1000,
      modelUsed: "claude-haiku-4-5",
      tokens: { prompt: 10, completion: 5, total: 15 },
      costUsd: "0.0001",
      inputContext: { prompt: "grade this" },
      outputContext: { text: "graded" },
    },
    {
      stepId: "block-b",
      attempt: 1,
      status: "failed",
      startedAt: "2026-09-16T00:00:01Z",
      completedAt: "2026-09-16T00:00:02Z",
      durationMs: 1000,
      errorContext: { message: "block failed" },
    },
  ],
};

interface StubOpts {
  throw?: Error;
  traceBody?: unknown;
  traceThrows?: boolean;
}

function stubTransport(spanFactory: SpanFactory, body: unknown, opts: StubOpts = {}): Transport {
  const state = { traceFetched: false };
  return {
    spanFactory,
    defaultSessionId: undefined,
    _state: state,
    request: async (method: string, path: string) => {
      if (method === "GET" && path.endsWith("/trace")) {
        state.traceFetched = true;
        if (opts.traceThrows) throw new NoukaiError("trace boom");
        return { statusCode: 200, body: opts.traceBody, requestId: "r2", headers: new Headers() };
      }
      if (opts.throw) throw opts.throw;
      return { statusCode: 200, body, requestId: "r", headers: new Headers() };
    },
  } as unknown as Transport;
}

describe("OTel span factory wiring", () => {
  it("disabled returns a no-op factory", () => {
    expect(makeSpanFactory(false)).toBeInstanceOf(NoopSpanFactory);
  });

  it("client is off by default (no-op factory)", () => {
    const client = new Noukai({ apiKey: "nk_test", org: "acme", project: "proj" });
    expect((client as any)._transport.spanFactory).toBeInstanceOf(NoopSpanFactory);
  });

  it("client otel:true uses a non-no-op factory", () => {
    const client = new Noukai({ apiKey: "nk_test", org: "acme", project: "proj", otel: true });
    expect((client as any)._transport.spanFactory).not.toBeInstanceOf(NoopSpanFactory);
  });
});

describe("OTel span emission through execute()", () => {
  it("emits one CLIENT span with noukai.* attributes", async () => {
    const flow = new Flow({
      transport: stubTransport(makeSpanFactory(true, tracer), COMPLETED_BODY),
      org: "acme",
      project: "proj",
      slug: "grade",
    });

    const result = await flow.execute({ message: "hi" });
    expect((result as any).status).toBe("completed");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("noukai.flow.execute");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes["noukai.org"]).toBe("acme");
    expect(span.attributes["noukai.project"]).toBe("proj");
    expect(span.attributes["noukai.flow.slug"]).toBe("grade");
    // Default version is now "production" (design 20260917-SDK-version-production-routing).
    expect(span.attributes["noukai.flow.version"]).toBe("production");
    expect(span.attributes["noukai.execution_id"]).toBe("exec-123");
    expect(span.attributes["noukai.flow.status"]).toBe("completed");
  });

  it("emits no span when otel is off", async () => {
    const flow = new Flow({
      transport: stubTransport(new NoopSpanFactory(), COMPLETED_BODY),
      org: "acme",
      project: "proj",
      slug: "grade",
    });
    const result = await flow.execute({ message: "hi" });
    expect((result as any).status).toBe("completed");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("records the exception and sets ERROR status, then rethrows", async () => {
    const boom = new NoukaiError("boom");
    const flow = new Flow({
      transport: stubTransport(makeSpanFactory(true, tracer), null, { throw: boom }),
      org: "acme",
      project: "proj",
      slug: "grade",
    });

    await expect(flow.execute({ message: "hi" })).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.filter((e) => e.name === "exception")).toHaveLength(1);
  });
});

describe("OTel per-block child spans (otelSteps)", () => {
  it("emits one backdated INTERNAL child span per block, nested under the parent", async () => {
    const transport = stubTransport(makeSpanFactory(true, tracer, { stepSpans: true }), COMPLETED_BODY, {
      traceBody: TRACE_BODY,
    });
    const flow = new Flow({ transport, org: "acme", project: "proj", slug: "grade" });
    await flow.execute({ message: "hi" });

    expect((transport as any)._state.traceFetched).toBe(true);
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "noukai.flow.execute")!;
    const children = spans.filter((s) => s.name === "noukai.flow.step");
    expect(children).toHaveLength(2);

    const a = children.find((s) => s.attributes["noukai.step.id"] === "block-a")!;
    // nested under the parent call span
    const childParentId = (a as any).parentSpanContext?.spanId ?? (a as any).parentSpanId;
    expect(childParentId).toBe(parent.spanContext().spanId);
    // backdated to the block's real start/end (catches Date.parse → ms unit bugs)
    const hrToMs = (hr: unknown): number => {
      const [s, n] = hr as [number, number];
      return s * 1000 + n / 1e6;
    };
    expect(hrToMs(a.startTime)).toBe(Date.parse("2026-09-16T00:00:00Z"));
    expect(hrToMs(a.endTime)).toBe(Date.parse("2026-09-16T00:00:01Z"));
    // metadata (gen_ai.* + noukai.*)
    expect(a.attributes["gen_ai.request.model"]).toBe("claude-haiku-4-5");
    expect(a.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(a.attributes["gen_ai.usage.output_tokens"]).toBe(5);
    expect(a.attributes["noukai.step.cost_usd"]).toBe("0.0001");
    expect(a.attributes["noukai.step.status"]).toBe("completed");
    // payloads NOT attached by default
    expect(a.attributes["noukai.step.input"]).toBeUndefined();
    expect(a.attributes["noukai.step.output"]).toBeUndefined();
    // failed block → ERROR status
    const b = children.find((s) => s.attributes["noukai.step.id"] === "block-b")!;
    expect(b.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("attaches bounded input/output when otelStepPayloads is on", async () => {
    const transport = stubTransport(
      makeSpanFactory(true, tracer, { stepSpans: true, stepPayloads: true }),
      COMPLETED_BODY,
      { traceBody: TRACE_BODY },
    );
    const flow = new Flow({ transport, org: "acme", project: "proj", slug: "grade" });
    await flow.execute({ message: "hi" });

    const a = exporter
      .getFinishedSpans()
      .find((s) => s.name === "noukai.flow.step" && s.attributes["noukai.step.id"] === "block-a")!;
    expect(String(a.attributes["noukai.step.input"])).toContain("grade this");
    expect(String(a.attributes["noukai.step.output"])).toContain("graded");

    // A failed block's error context is attached (bounded) under the payloads flag.
    const b = exporter
      .getFinishedSpans()
      .find((s) => s.name === "noukai.flow.step" && s.attributes["noukai.step.id"] === "block-b")!;
    expect(String(b.attributes["noukai.step.error"])).toContain("block failed");
  });

  it("does not fetch the trace when otelSteps is off", async () => {
    const transport = stubTransport(makeSpanFactory(true, tracer), COMPLETED_BODY, {
      traceBody: TRACE_BODY,
    });
    const flow = new Flow({ transport, org: "acme", project: "proj", slug: "grade" });
    await flow.execute({ message: "hi" });

    expect((transport as any)._state.traceFetched).toBe(false);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["noukai.flow.execute"]);
  });

  it("swallows a trace-fetch failure without breaking the call", async () => {
    const transport = stubTransport(makeSpanFactory(true, tracer, { stepSpans: true }), COMPLETED_BODY, {
      traceThrows: true,
    });
    const flow = new Flow({ transport, org: "acme", project: "proj", slug: "grade" });

    const result = await flow.execute({ message: "hi" });
    expect((result as any).status).toBe("completed");
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["noukai.flow.execute"]);
    expect(spans[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("client otelSteps flag enables step spans", () => {
    const client = new Noukai({ apiKey: "nk_test", org: "a", project: "p", otelSteps: true });
    expect((client as any)._transport.spanFactory.stepSpansEnabled).toBe(true);
    expect((client as any)._transport.spanFactory).not.toBeInstanceOf(NoopSpanFactory);
  });
});
