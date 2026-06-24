/**
 * POST /seq/{org}/{project}/{slug}/execute body.
 * camelCase matches the server wire format (Pydantic `serialization_alias`).
 */
export interface ExecuteRequest {
  message?: string | null;
  parameters?: Record<string, unknown>;
  blockOverrides?: Record<string, Record<string, unknown>>;
  attachments?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  toolChoice?: unknown;
  /** Present on resume calls — links to flow_runs row. */
  executionId?: string;
  pausedAtStep?: string;
  iterationsUsed?: number;
  toolCallMessages?: Record<string, unknown>[];
  accumulatedOutputs?: Record<string, unknown>;
  trace?: boolean;
  /**
   * Explicit version selector. Omit for draft (default). Pass an integer to pin
   * to a specific published version. `"production"` will be supported in a
   * future release once the server-side routing lands.
   */
  version?: "production" | number;
}

/** POST /seq/{org}/{project}/{slug}/step body. */
export interface StepRequest {
  executionId?: string;
  stepIndex?: number;
  accumulatedOutputs?: Record<string, unknown>;
  message?: string | null;
  parameters?: Record<string, unknown>;
  inputOverrides?: Record<string, unknown>;
  blockOverrides?: Record<string, Record<string, unknown>>;
  runRemaining?: boolean;
  tools?: Record<string, unknown>[];
  toolChoice?: unknown;
  toolCallMessages?: Record<string, unknown>[];
  iterationsUsed?: number;
  trace?: boolean;
}
