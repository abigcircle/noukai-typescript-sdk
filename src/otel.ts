/**
 * Optional, opt-in OpenTelemetry integration (customer-side tracing).
 *
 * When a client is constructed with `otel: true`, each `flow.execute` /
 * `flow.executeAsync` call emits **one parent span of kind CLIENT** into the
 * caller's own configured OpenTelemetry provider (Datadog / Honeycomb / Jaeger
 * / any OTLP backend). The SDK produces no new data — the span carries the
 * org/project/slug/executionId/status the call already has.
 *
 * With `otelSteps: true` the SDK additionally fetches `run.trace()` after a
 * completed `execute` and synthesizes one child span per pipeline block,
 * backdated to the block's real start/end, nested under the parent — carrying
 * the block's model, token usage, cost, duration, and status. With
 * `otelStepPayloads: true` each child also carries a size-bounded copy of the
 * block's input data and output results (off by default — this can contain PII).
 *
 * When `otel` is falsy (the default) this module hands back a no-op factory
 * that never imports `@opentelemetry/api`; the off path emits nothing and adds
 * only a small closure/object allocation per call.
 *
 * `@opentelemetry/api` is an optional peer dependency, imported dynamically and
 * only when otel is on. Because ESM dynamic import is async, it is resolved
 * lazily on the first traced call; a missing dependency then surfaces as a
 * clear {@link NoukaiError} there.
 *
 * This module is the SDK's only point of contact with `@opentelemetry/api`;
 * the rest of the SDK talks to the language-neutral {@link SpanFactory} /
 * {@link FlowSpan}. Follows OTel semantic conventions: span kind CLIENT for the
 * call, `gen_ai.*` for per-block model/token usage.
 */

import type * as OtelApi from "@opentelemetry/api";

import { NoukaiError } from "./errors.js";
import type { StepTrace } from "./types/trace.js";
import { VERSION } from "./version.js";

// Cap the serialized size of a per-block input/output payload attribute so a
// large block context can't blow past OTel backends' attribute-size limits.
const MAX_STEP_PAYLOAD_CHARS = 4096;

export interface FlowSpanAttrs {
  org: string;
  project: string;
  slug: string;
  version: string;
}

/** Language-neutral handle the Flow proxy sets end-of-call state through. */
export interface FlowSpan {
  setExecutionId(executionId: string | null | undefined): void;
  setStatus(status: string | null | undefined): void;
  emitStepSpans(steps: StepTrace[]): void;
}

/** Runs `fn` inside one parent CLIENT span, handing it a {@link FlowSpan}. */
export interface SpanFactory {
  readonly stepSpansEnabled: boolean;
  flowSpan<T>(op: string, attrs: FlowSpanAttrs, fn: (span: FlowSpan) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Helpers (no @opentelemetry/api import)
// ---------------------------------------------------------------------------

/** ISO-8601 → epoch milliseconds (OTel JS `TimeInput`), or undefined. */
function isoToEpochMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Serialize to JSON, truncating to `maxChars` chars with a marker. Callers
 * only pass block contexts (objects), so `JSON.stringify` yields a string. */
function boundedJson(obj: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(obj);
  } catch {
    // Matches the Python SDK: a non-serializable context (e.g. a cycle) falls
    // back to its string form rather than aborting the remaining child spans.
    text = String(obj);
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}…[truncated ${String(text.length - maxChars)} chars]`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// No-op (default; never imports @opentelemetry/api)
// ---------------------------------------------------------------------------

const NOOP_SPAN: FlowSpan = {
  setExecutionId() {
    /* no-op */
  },
  setStatus() {
    /* no-op */
  },
  emitStepSpans() {
    /* no-op */
  },
};

export class NoopSpanFactory implements SpanFactory {
  readonly stepSpansEnabled = false;

  flowSpan<T>(_op: string, _attrs: FlowSpanAttrs, fn: (span: FlowSpan) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  }
}

// ---------------------------------------------------------------------------
// Real implementation (only reached when otel is enabled)
// ---------------------------------------------------------------------------

class OtelFlowSpan implements FlowSpan {
  constructor(
    private readonly span: OtelApi.Span,
    private readonly tracer: OtelApi.Tracer,
    private readonly childContext: (parent: OtelApi.Span) => OtelApi.Context,
    private readonly internalKind: OtelApi.SpanKind,
    private readonly errorCode: OtelApi.SpanStatusCode,
    private readonly payloads: boolean,
    private readonly maxChars: number,
  ) {}

  setExecutionId(executionId: string | null | undefined): void {
    if (executionId != null) this.span.setAttribute("noukai.execution_id", executionId);
  }

  setStatus(status: string | null | undefined): void {
    if (status != null) this.span.setAttribute("noukai.flow.status", status);
  }

  emitStepSpans(steps: StepTrace[]): void {
    // Explicitly parent each child to the call span so nesting is correct even
    // when no OTel ContextManager is registered (startActiveSpan alone does not
    // propagate the active span without one).
    const parentContext = this.childContext(this.span);
    for (const st of steps) {
      const startMs = isoToEpochMs(st.startedAt);
      const child = this.tracer.startSpan(
        "noukai.flow.step",
        { kind: this.internalKind, ...(startMs !== undefined ? { startTime: startMs } : {}) },
        parentContext,
      );
      this.setStepAttributes(child, st);
      if (st.status === "failed") child.setStatus({ code: this.errorCode });
      child.end(isoToEpochMs(st.completedAt));
    }
  }

  private setStepAttributes(span: OtelApi.Span, st: StepTrace): void {
    span.setAttribute("noukai.step.id", st.stepId);
    span.setAttribute("noukai.step.attempt", st.attempt);
    span.setAttribute("noukai.step.status", st.status);
    if (st.durationMs !== undefined) span.setAttribute("noukai.step.duration_ms", st.durationMs);
    if (st.loopIndex != null) span.setAttribute("noukai.step.loop_index", st.loopIndex);
    if (st.modelUsed !== undefined) span.setAttribute("gen_ai.request.model", st.modelUsed);
    if (st.tokens !== undefined) {
      span.setAttribute("gen_ai.usage.input_tokens", st.tokens.prompt);
      span.setAttribute("gen_ai.usage.output_tokens", st.tokens.completion);
    }
    if (st.costUsd !== undefined) span.setAttribute("noukai.step.cost_usd", st.costUsd);
    if (this.payloads) {
      if (st.inputContext !== undefined) {
        span.setAttribute("noukai.step.input", boundedJson(st.inputContext, this.maxChars));
      }
      if (st.outputContext !== undefined) {
        span.setAttribute("noukai.step.output", boundedJson(st.outputContext, this.maxChars));
      }
      // For a failed block the error context is its "result" — attach it (bounded,
      // gated by the same payloads flag) so the span is diagnostic.
      if (st.errorContext !== undefined) {
        span.setAttribute("noukai.step.error", boundedJson(st.errorContext, this.maxChars));
      }
    }
  }
}

class OtelSpanFactory implements SpanFactory {
  constructor(
    private readonly tracer: OtelApi.Tracer,
    private readonly clientKind: OtelApi.SpanKind,
    private readonly internalKind: OtelApi.SpanKind,
    private readonly errorCode: OtelApi.SpanStatusCode,
    private readonly childContext: (parent: OtelApi.Span) => OtelApi.Context,
    readonly stepSpansEnabled: boolean,
    private readonly stepPayloads: boolean,
    private readonly maxChars: number,
  ) {}

  flowSpan<T>(op: string, attrs: FlowSpanAttrs, fn: (span: FlowSpan) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(
      `noukai.flow.${op}`,
      { kind: this.clientKind },
      async (span: OtelApi.Span): Promise<T> => {
        span.setAttribute("noukai.org", attrs.org);
        span.setAttribute("noukai.project", attrs.project);
        span.setAttribute("noukai.flow.slug", attrs.slug);
        span.setAttribute("noukai.flow.version", attrs.version);
        const handle = new OtelFlowSpan(
          span,
          this.tracer,
          this.childContext,
          this.internalKind,
          this.errorCode,
          this.stepPayloads,
          this.maxChars,
        );
        try {
          return await fn(handle);
        } catch (e) {
          span.recordException(e instanceof Error ? e : new Error(String(e)));
          span.setStatus({ code: this.errorCode, message: String(e) });
          throw e;
        } finally {
          span.end();
        }
      },
    );
  }
}

/**
 * Wraps {@link OtelSpanFactory}, resolving `@opentelemetry/api` on the first
 * traced call (ESM dynamic import is async). Throws {@link NoukaiError} if the
 * peer dep is absent. `stepSpansEnabled` is known from config up-front.
 */
class LazyOtelSpanFactory implements SpanFactory {
  private resolved: SpanFactory | null = null;

  constructor(
    private readonly tracer: unknown,
    readonly stepSpansEnabled: boolean,
    private readonly stepPayloads: boolean,
  ) {}

  async flowSpan<T>(op: string, attrs: FlowSpanAttrs, fn: (span: FlowSpan) => Promise<T>): Promise<T> {
    this.resolved ??= await this.resolve();
    return this.resolved.flowSpan(op, attrs, fn);
  }

  private async resolve(): Promise<SpanFactory> {
    const api = await import("@opentelemetry/api").catch(() => {
      throw new NoukaiError(
        "new Noukai({ otel: true }) requires @opentelemetry/api. Install it " +
          "(`npm i @opentelemetry/api`) or pass an explicit `tracer`.",
      );
    });
    const tracer =
      (this.tracer as OtelApi.Tracer | undefined) ?? api.trace.getTracer("@noukai/sdk", VERSION);
    const childContext = (parent: OtelApi.Span): OtelApi.Context =>
      api.trace.setSpan(api.context.active(), parent);
    return new OtelSpanFactory(
      tracer,
      api.SpanKind.CLIENT,
      api.SpanKind.INTERNAL,
      api.SpanStatusCode.ERROR,
      childContext,
      this.stepSpansEnabled,
      this.stepPayloads,
      MAX_STEP_PAYLOAD_CHARS,
    );
  }
}

export interface SpanFactoryOptions {
  stepSpans?: boolean;
  stepPayloads?: boolean;
}

/**
 * Build the span factory for a client. `enabled=false` → a {@link NoopSpanFactory}
 * that never imports OpenTelemetry. `enabled=true` → a lazy factory that emits
 * CLIENT spans (and, when `stepSpans`, per-block child spans) into the caller's
 * provider or the explicit `tracer`.
 */
export function makeSpanFactory(
  enabled: boolean,
  tracer?: unknown,
  opts: SpanFactoryOptions = {},
): SpanFactory {
  if (!enabled) return new NoopSpanFactory();
  return new LazyOtelSpanFactory(tracer, opts.stepSpans ?? false, opts.stepPayloads ?? false);
}
