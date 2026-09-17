/**
 * Optional, opt-in OpenTelemetry integration (customer-side tracing).
 *
 * When a client is constructed with `otel: true`, each `flow.execute` /
 * `flow.executeAsync` call emits **one parent span of kind CLIENT** into the
 * caller's own configured OpenTelemetry provider (Datadog / Honeycomb / Jaeger
 * / any OTLP backend). The SDK produces no new data — the span carries the
 * org/project/slug/executionId/status the call already has.
 *
 * When `otel` is falsy (the default) this module hands back a no-op factory
 * that never imports `@opentelemetry/api`; the off path emits nothing and adds
 * only a small closure/object allocation per call.
 *
 * `@opentelemetry/api` is an *optional peer dependency*: it is imported
 * dynamically (so bundlers never hard-require it) and only when otel is on.
 * Because ESM dynamic import is async, the dependency is resolved lazily on the
 * first traced call (not at client construction); a missing dependency then
 * surfaces as a clear {@link NoukaiError} on that first call.
 *
 * This module is the SDK's only point of contact with `@opentelemetry/api`;
 * the rest of the SDK talks to the language-neutral {@link SpanFactory}. Follows
 * OTel semantic conventions: span kind CLIENT; `gen_ai.*` is reserved for the
 * (deferred) per-step child spans, so v1 uses self-namespaced `noukai.*` only.
 */

import type * as OtelApi from "@opentelemetry/api";

import { NoukaiError } from "./errors.js";
import { VERSION } from "./version.js";

export interface FlowSpanAttrs {
  org: string;
  project: string;
  slug: string;
  version: string;
}

/** Runs `fn` inside one parent CLIENT span, tagging the resolved result. */
export interface SpanFactory {
  flowSpan<T>(op: string, attrs: FlowSpanAttrs, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// No-op (default; never imports @opentelemetry/api)
// ---------------------------------------------------------------------------

export class NoopSpanFactory implements SpanFactory {
  flowSpan<T>(_op: string, _attrs: FlowSpanAttrs, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ---------------------------------------------------------------------------
// Real implementation (only reached when otel is enabled)
// ---------------------------------------------------------------------------

/** Read `executionId`/`status` off the resolved flow result, generically. */
function tagResult(span: OtelApi.Span, result: unknown): void {
  if (result === null || typeof result !== "object") return;
  const rec = result as Record<string, unknown>;
  const executionId = rec.executionId;
  if (typeof executionId === "string") span.setAttribute("noukai.execution_id", executionId);
  const status = rec.status;
  if (typeof status === "string") span.setAttribute("noukai.flow.status", status);
}

class OtelSpanFactory implements SpanFactory {
  constructor(
    private readonly tracer: OtelApi.Tracer,
    private readonly clientKind: OtelApi.SpanKind,
    private readonly errorCode: OtelApi.SpanStatusCode,
  ) {}

  flowSpan<T>(op: string, attrs: FlowSpanAttrs, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(
      `noukai.flow.${op}`,
      { kind: this.clientKind },
      async (span: OtelApi.Span): Promise<T> => {
        span.setAttribute("noukai.org", attrs.org);
        span.setAttribute("noukai.project", attrs.project);
        span.setAttribute("noukai.flow.slug", attrs.slug);
        span.setAttribute("noukai.flow.version", attrs.version);
        try {
          const result = await fn();
          tagResult(span, result);
          return result;
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
 * traced call (ESM dynamic import is async, so this can't happen in the sync
 * client constructor). Throws {@link NoukaiError} if the peer dep is absent.
 */
class LazyOtelSpanFactory implements SpanFactory {
  private resolved: SpanFactory | null = null;

  constructor(private readonly tracer: unknown) {}

  async flowSpan<T>(op: string, attrs: FlowSpanAttrs, fn: () => Promise<T>): Promise<T> {
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
      (this.tracer as OtelApi.Tracer | undefined) ??
      api.trace.getTracer("@noukai/sdk", VERSION);
    return new OtelSpanFactory(tracer, api.SpanKind.CLIENT, api.SpanStatusCode.ERROR);
  }
}

/**
 * Build the span factory for a client. `enabled=false` → a zero-overhead
 * {@link NoopSpanFactory} that never imports OpenTelemetry. `enabled=true` →
 * a lazy factory that emits CLIENT spans into the caller's provider (or the
 * explicit `tracer`).
 */
export function makeSpanFactory(enabled: boolean, tracer?: unknown): SpanFactory {
  return enabled ? new LazyOtelSpanFactory(tracer) : new NoopSpanFactory();
}
