/**
 * Output-snapshot helpers for replay reconstruction.
 *
 * Trace snapshots persisted in `output_snapshot` carry reserved sidecar keys
 * that are NOT part of the business result. On the live execution path the
 * backend pops these out of the block output before returning it, and
 * re-persists them into the snapshot purely for trace viewing (see
 * `TrackedBlockExecutor`, which pops `__rendered_prompt__` from `raw_output`
 * and stores it under `output_snapshot.__rendered_prompt__`).
 *
 * Replay reconstruction reads the raw snapshot, so it must project those
 * sidecars back out — otherwise the replayed `result`/`output` would be a
 * superset of the live shape and round-trip equality checks fail.
 */

/**
 * Reserved sidecar keys that live inside `output_snapshot` but are not part of
 * the business result. Mirrors the keys the backend strips on the live path.
 * `__rendered_prompt__` is the only one re-persisted into the snapshot today;
 * the list is kept extensible for future sidecars.
 */
export const RESERVED_SNAPSHOT_KEYS: readonly string[] = ["__rendered_prompt__"];

/**
 * Return a shallow copy of an output snapshot with reserved trace sidecar keys
 * removed, recovering the business-result shape produced by a live execution.
 *
 * Non-plain-object inputs (null/undefined/array/primitive) pass through
 * unchanged, as do snapshots that contain no reserved keys (returned as-is to
 * avoid needless allocation).
 */
export function stripTraceSidecars(
  snapshot: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (snapshot === null || snapshot === undefined) return snapshot;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  if (!RESERVED_SNAPSHOT_KEYS.some((k) => k in snapshot)) return snapshot;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (!RESERVED_SNAPSHOT_KEYS.includes(k)) copy[k] = v;
  }
  return copy;
}
