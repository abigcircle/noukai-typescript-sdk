export interface ExecuteResult {
  status: "completed" | "failed";
  result?: unknown;
  flowId: string;
  blockCount: number;
  executionId?: string;
  /**
   * Session id this execution was tagged with (capture mode) or replayed from
   * (replay mode). Undefined when called outside a trace scope.
   *
   * Set by the SDK after parsing — not present on the wire response.
   */
  sessionId?: string;
  /** Always false; lets union narrowing work. */
  readonly requiresToolCalls: false;
}

export interface PausedResult {
  status: "tool_calls_required";
  executionId: string;
  pausedAtStep: string;
  iterationsUsed: number;
  toolCallMessages: Record<string, unknown>[];
  toolCalls: Record<string, unknown>[];
  accumulatedOutputs: Record<string, unknown>;
  flowId: string;
  blockCount: number;
  /**
   * Session id this execution was tagged with (capture mode) or replayed from
   * (replay mode). Undefined when called outside a trace scope.
   *
   * Set by the SDK after parsing — not present on the wire response.
   */
  sessionId?: string;
  /** Always true; lets union narrowing work. */
  readonly requiresToolCalls: true;
  /** Continue the run with tool results (wired in Phase 5). */
  resume(args: { toolResults: Record<string, unknown>[] }): Promise<ExecuteResult | PausedResult>;
}

export interface JobAccepted {
  executionId: string;
  status: string;
  flowId: string;
  blockCount: number;
  /**
   * Session id this async job was submitted with. Undefined when submitted
   * outside a trace scope.
   *
   * Set by the SDK after parsing — not present on the wire response.
   */
  sessionId?: string;
}

export interface JobStatus {
  executionId: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
}
