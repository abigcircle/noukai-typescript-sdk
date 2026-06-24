/**
 * Integration tests for Flow.executeAsync() — queue-backed async execution.
 *
 * Skipped by default. Set the NOUKAI_INTEGRATION_* env vars to enable.
 * See tests/integration/README.md for setup instructions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APITimeoutError, type Noukai } from "../../src/index.js";
import { helloFlow, integrationReady, makeClient } from "./helpers.js";

describe.skipIf(!integrationReady)("executeAsync (integration)", () => {
  let client: Noukai;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it(
    "executeAsync returns a Job with executionId and flowId",
    async () => {
      const job = await helloFlow(client).executeAsync({ message: "hello async" });

      expect(job.executionId).toBeTruthy();
      expect(job.flowId).toBeTruthy();
    },
    30_000,
  );

  it(
    "job.poll() returns a JobStatus with a valid status",
    async () => {
      const job = await helloFlow(client).executeAsync({ message: "polling test" });
      const status = await job.poll();

      expect(["pending", "running", "completed", "failed"]).toContain(status.status);
      expect(status.executionId).toBe(job.executionId);
    },
    30_000,
  );

  it(
    "job.wait() resolves to a terminal JobStatus",
    async () => {
      const job = await helloFlow(client).executeAsync({ message: "wait test" });
      const status = await job.wait({ timeout: 60_000, pollInterval: 1_000 });

      expect(["completed", "failed"]).toContain(status.status);
      expect(status.executionId).toBe(job.executionId);
    },
    90_000,
  );

  it(
    "job.wait() with timeout: 1 throws APITimeoutError before the job finishes",
    async () => {
      const job = await helloFlow(client).executeAsync({ message: "timeout test" });

      // 1ms is effectively zero — the job will almost certainly still be pending
      // or running by the time wait() checks the deadline.
      await expect(job.wait({ timeout: 1, pollInterval: 500 })).rejects.toThrow(APITimeoutError);
    },
    30_000,
  );

  it(
    "two concurrent executeAsync calls produce distinct executionIds",
    async () => {
      const flow = helloFlow(client);
      const [jobA, jobB] = await Promise.all([
        flow.executeAsync({ message: "concurrent A" }),
        flow.executeAsync({ message: "concurrent B" }),
      ]);

      expect(jobA.executionId).not.toBe(jobB.executionId);
    },
    30_000,
  );
});
