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

function stubTransport(
  spanFactory: SpanFactory,
  body: unknown,
  opts: { throw?: Error } = {},
): Transport {
  return {
    spanFactory,
    defaultSessionId: undefined,
    request: async () => {
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
    expect(span.attributes["noukai.flow.version"]).toBe("draft");
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
