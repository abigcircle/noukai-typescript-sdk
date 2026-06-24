export interface TokenBreakdown {
  prompt: number;
  completion: number;
  total: number;
}

export interface StepTrace {
  stepId: string;
  attempt: number;
  loopIndex?: number | null;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  modelUsed?: string;
  tokens?: TokenBreakdown;
  costUsd?: string;
  inputContext?: Record<string, unknown>;
  outputContext?: Record<string, unknown>;
  errorContext?: Record<string, unknown>;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  truncated?: boolean;
}

export interface RunSummary {
  id: string;
  flowId: string;
  status: string;
  triggerType?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  stepCount?: number;
}

export interface Trace {
  flowRun: RunSummary;
  steps: StepTrace[];
}

export interface StepAttempts {
  stepId: string;
  attempts: StepTrace[];
}
