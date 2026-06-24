import type { SessionResponse } from "../types/session.js";

export const ScopeMode = {
  NORMAL: "normal",
  CAPTURE: "capture",
  REPLAY: "replay",
} as const;
export type ScopeModeValue = (typeof ScopeMode)[keyof typeof ScopeMode];

export interface ReplayCursor {
  bySlug: Map<string, number>;
}

export function nextIndex(cursor: ReplayCursor, slug: string): number {
  const i = cursor.bySlug.get(slug) ?? 0;
  cursor.bySlug.set(slug, i + 1);
  return i;
}

export function newCursor(): ReplayCursor {
  return { bySlug: new Map() };
}

export interface StepFlowMapping {
  codeExecIdToRecorded: Map<string, string>;
}

export interface ScopeState {
  mode: ScopeModeValue;
  sessionId: string | null;
  fetchedSession: SessionResponse | null;
  executeCursor: ReplayCursor;
  stepFirstCallCursor: ReplayCursor;
  stepMapping: StepFlowMapping;
  consumedExecutionIds: Set<string>;
}

export function newScopeState(mode: ScopeModeValue, sessionId: string | null): ScopeState {
  return {
    mode,
    sessionId,
    fetchedSession: null,
    executeCursor: newCursor(),
    stepFirstCallCursor: newCursor(),
    stepMapping: { codeExecIdToRecorded: new Map() },
    consumedExecutionIds: new Set(),
  };
}
