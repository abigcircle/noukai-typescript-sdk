/**
 * A single structured chat turn (design 20260903-SDK-agent-relay, F6).
 *
 * Tracks the shared `llm_service.models.ChatMessage` shape:
 * `role`/`content`/`toolCalls`/`toolCallId`/`name`. Deliberately permissive
 * — the SDK's job is to *express* `messages`, not re-police it; the server
 * validates. Field names are **camelCase**, matching the Noukai wire (the
 * router-ai-slugs execute API accepts/emits camelCase for message contents;
 * snake_case now lives only at the external LLM-provider boundary). Unknown
 * fields pass through via the index signature.
 *
 * `role` is typed permissively; the SDK still rejects `system`/`function` (and
 * any non user|assistant|tool role) client-side before the request goes out.
 */
export interface ChatMessage {
  role: string;
  content?: unknown;
  toolCalls?: Record<string, unknown>[];
  toolCallId?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * POST /seq/{org}/{project}/{slug}/execute body.
 * camelCase matches the server wire format (Pydantic `serialization_alias`).
 */
export interface ExecuteRequest {
  message?: string | null;
  /**
   * Structured prior conversation for chat/agent flows; the last entry is the
   * current user turn. When set it stands in for `message` (server contract).
   */
  messages?: ChatMessage[];
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
  // Note: there is no `version` body field. The server routes versions by URL
  // path (base = production, /v0 = draft, /vN = version N); see paths.ts and
  // Flow._pathVersion. Design 20260917-SDK-version-production-routing.
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
