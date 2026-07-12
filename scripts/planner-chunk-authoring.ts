/**
 * planner-chunk-authoring — bounded per-result size for runPlanJob's authoring
 * step in scripts/builder-worker.ts.
 *
 * A single planner turn asked to author N approved specs in one giant JSON
 * envelope produced results that the primary ingestion parse dropped (job
 * d5999907: a 62KB, 6-spec envelope → 0 specs authored). Phase 1 added a
 * transcript fallback that recovers those drops from the on-disk jsonl.
 * Phase 2 (this module) attacks the root: chunk the planner request into
 * bounded batches of at most K specs per turn so no single result approaches
 * the size that caused the drop in the first place, and each authored spec is
 * committed to `public.specs` the moment `authorSpecRowStructured` returns —
 * so a failure on chunk k+1 leaves the specs from chunks 1..k persisted in
 * review, not rolled back to zero.
 *
 * Docs: docs/brain/specs/planner-authoring-survives-large-multi-spec-output.md
 * Phase 2 — Bound per-result size: incremental / chunked spec authoring.
 */

/**
 * Bound on the number of approved specs per planner turn. Small (2) so that
 * even a spec pair with heavy verification checklists produces a result well
 * under the size at which the ingestion drop kicked in — the 62KB, 6-spec
 * envelope averaged ~10KB per spec, so a 2-spec batch is comfortably ~20KB.
 * Not a hard byte cap; the caller LOGS resultText.length per batch so
 * operators can see if a single spec ever grows large enough to warrant K=1.
 */
export const PLANNER_AUTHOR_BATCH_SIZE = 2;

/**
 * Split an ordered list into bounded chunks of at most `size` items each,
 * preserving order and producing independent slices (mid-loop failure on
 * chunk k+1 can never mutate the prior chunks the caller already committed).
 *
 * Preserves the total set: `chunkForAuthoring(xs, k).flat()` deep-equals `xs`
 * for any positive `k`. `xs=[]` returns `[]`. `size <= 0` is a caller bug and
 * throws — the caller must never ask for zero-width chunks.
 */
export function chunkForAuthoring<T>(items: T[], size: number = PLANNER_AUTHOR_BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkForAuthoring: size must be a positive integer (got ${size})`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
