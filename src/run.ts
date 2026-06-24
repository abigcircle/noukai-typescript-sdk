import type { Transport } from "./transport.js";
import type { Trace, StepTrace, StepAttempts } from "./types/trace.js";
import type { StreamEvent } from "./types/events.js";
import { parseSSEStream } from "./streaming.js";
import { runPath } from "./paths.js";

export type AttemptSpec = "latest" | "all" | number;

export interface StepTraceOptions {
  attempt?: AttemptSpec;
  loopIndex?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export class Run {
  readonly executionId: string;

  constructor(
    private readonly _opts: {
      transport: Transport;
      org: string;
      project: string;
      slug: string;
      executionId: string;
    },
  ) {
    this.executionId = _opts.executionId;
  }

  private get _basePath(): string {
    return runPath(this._opts.org, this._opts.project, this._opts.slug, this.executionId);
  }

  async trace(opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<Trace> {
    const resp = await this._opts.transport.request<Trace>(
      "GET",
      `${this._basePath}/trace`,
      {
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );
    if (resp.body === null) {
      throw new Error("trace: server returned empty response body");
    }
    return resp.body;
  }

  async stepTrace(
    stepId: string,
    opts: StepTraceOptions = {},
  ): Promise<StepTrace | StepAttempts> {
    const params: Record<string, string> = {};
    // Omit `attempt` when it's the default ("latest") — let the server use its
    // own default rather than risking a wire-incompatibility with an explicit
    // "latest" string.
    const attempt = opts.attempt ?? "latest";
    if (attempt !== "latest") {
      params.attempt = String(attempt);
    }
    if (opts.loopIndex !== undefined) {
      params.loop_index = String(opts.loopIndex);
    }
    const resp = await this._opts.transport.request<StepTrace | StepAttempts>(
      "GET",
      `${this._basePath}/steps/${stepId}/trace`,
      {
        params,
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );
    if (resp.body === null) {
      throw new Error("stepTrace: server returned empty response body");
    }
    return resp.body;
  }

  async *liveTrace(): AsyncIterable<StreamEvent> {
    const path = `${this._basePath}/trace/stream`;
    const byteStream = this._opts.transport.stream("GET", path);
    for await (const event of parseSSEStream(byteStream)) {
      yield event;
    }
  }
}
