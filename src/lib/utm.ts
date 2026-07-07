// Shared UTM helpers for the Meta source family.
//
// The stored raw `utm_source` / `attributed_utm_source` values are heterogenous —
// Meta itself sets 'facebook' or 'fb' or 'ig' on many click destinations, our
// publish path stamps 'meta', operators occasionally paste 'instagram'. The
// attribution sensor and its callers must READ the whole family; the stored
// value is untouched (non-destructive read-side widening — see
// docs/brain/specs/attribution-sensor-recalibration.md Phase 1).
//
// Two exports:
//   - `isMetaUtm(src)`     — JS predicate; used by in-memory filters after fetch.
//   - `metaFamilyOr(col)`  — the PostgREST `.or()` argument for a case-insensitive
//                             family filter on `col` (drop-in for a hardcoded
//                             `.eq(col, 'meta')`).

/** True when `src` names any member of the Meta ad family (case-insensitive). */
export function isMetaUtm(src: string | null | undefined): boolean {
  if (!src) return false;
  const s = String(src).toLowerCase();
  return (
    s.includes("meta") ||
    s.includes("facebook") ||
    s.includes("instagram") ||
    s === "fb" ||
    s === "ig"
  );
}

/**
 * Returns the argument for a PostgREST `.or()` call that matches the whole Meta
 * ad family on `column`, case-insensitive. Use in place of a bare
 * `.eq(column, 'meta')` on `utm_source` / `attributed_utm_source`.
 *
 *   admin.from('orders')
 *     .select('...')
 *     .or(metaFamilyOr('attributed_utm_source'))
 *
 * PostgREST does not have a case-insensitive `eq`, so the short values 'fb'
 * and 'ig' are matched with an anchored `ilike` (no wildcards) — that mirrors
 * the JS predicate's `s === 'fb'` after `toLowerCase()` while remaining
 * case-insensitive at the DB layer.
 */
export function metaFamilyOr(column: string): string {
  return [
    `${column}.ilike.%meta%`,
    `${column}.ilike.%facebook%`,
    `${column}.ilike.%instagram%`,
    `${column}.ilike.fb`,
    `${column}.ilike.ig`,
  ].join(",");
}
