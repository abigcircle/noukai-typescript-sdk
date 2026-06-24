import type { JobStatus } from "./types/responses.js";
import type { Transport } from "./transport.js";
import { APITimeoutError, FlowNotFoundError } from "./errors.js";
import { flowJobPollPath } from "./paths.js";

// Grace window during which a 404 from the status endpoint is treated as
// "job not yet registered" rather than a missing execution. Covers the brief
// race between `executeAsync` returning and the orchestrator-worker inserting
// the flow_runs row.
const SUBMISSION_GRACE_MS = 5_000;

export interface WaitOptions {
  /** Total time to wait before throwing APITimeoutError. Default: 300_000ms. */
  timeout?: number;
  /** Time between polls. Default: 2_000ms. */
  pollInterval?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Job class
// ---------------------------------------------------------------------------

export class Job {
  readonly executionId: string;
  readonly flowId: string;
  private readonly _transport: Transport;
  private readonly _org: string;
  private readonly _project: string;
  private readonly _slug: string;
  private readonly _submittedAt: number;

  constructor(options: {
    transport: Transport;
    org: string;
    project: string;
    slug: string;
    executionId: string;
    flowId: string;
    /** Override the submission timestamp. Test seam — do not use in production code. */
    submittedAt?: number;
  }) {
    this._transport = options.transport;
    this._org = options.org;
    this._project = options.project;
    this._slug = options.slug;
    this.executionId = options.executionId;
    this.flowId = options.flowId;
    this._submittedAt = options.submittedAt ?? Date.now();
  }

  /**
   * One-shot status check.
   *
   * Race-window behavior: between the moment `executeAsync` returns and the
   * moment the orchestrator-worker inserts the `flow_runs` row, the status
   * endpoint returns 404. Within the 5s grace window after submission, we
   * synthesize a `pending` status rather than surface a misleading
   * `FlowNotFoundError`. After the grace window, real 404s propagate.
   */
  async poll(opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<JobStatus> {
    const url = flowJobPollPath(this._org, this._project, this._slug, this.executionId);
    try {
      const resp = await this._transport.request<JobStatus>("GET", url, {
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (resp.body === null) {
        throw new Error("poll: server returned empty response body");
      }
      return resp.body;
    } catch (err) {
      const inGrace = Date.now() - this._submittedAt < SUBMISSION_GRACE_MS;
      if (err instanceof FlowNotFoundError && inGrace) {
        return { executionId: this.executionId, status: "pending" };
      }
      throw err;
    }
  }

  /** Poll until status is terminal or timeout expires, then throw APITimeoutError. */
  async wait(opts: WaitOptions = {}): Promise<JobStatus> {
    const timeout = opts.timeout ?? 300_000;
    const interval = opts.pollInterval ?? 2_000;
    const deadline = Date.now() + timeout;

    for (;;) {
      // Build poll options, forwarding signal only when present.
      const pollOpts: { signal?: AbortSignal } = {};
      if (opts.signal !== undefined) pollOpts.signal = opts.signal;
      const status = await this.poll(pollOpts);

      if (status.status === "completed" || status.status === "failed") {
        return status;
      }

      if (Date.now() >= deadline) {
        throw new APITimeoutError(
          `Job ${this.executionId} did not complete within ${String(timeout)}ms`,
        );
      }

      await sleep(interval);
    }
  }
}
