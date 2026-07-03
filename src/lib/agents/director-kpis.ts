/**
 * Director-KPI SDK — one DB-derived source for every scorecard/recap "shipped specs" metric
 * (director-kpi-sdk spec, Phase 1).
 *
 * The bug this fixes: [[platform-scorecard]] `specs_per_week` and [[director-recap]] `specsShipped`
 * both used to build a spec_slug→owner map from `getRoadmap().specs` — which filters to LIVE specs
 * (folded excluded via `isBoardableStatus`). A merged build whose spec folds the SAME DAY loses its
 * owner mapping and drops out of both metrics. On a day with dozens of merged builds the headline
 * read '1 spec shipped' vs 108 folds — the bookkeeping was actively hiding done work.
 *
 * Fix: derive the slug→owner map from [[specs-table]] `listSpecs(workspaceId)` (returns EVERY spec
 * including `status='folded'`), so the count is the full merged-in-window population attributed to
 * an owner regardless of whether the spec has since folded. North-star invariant: display-only
 * proxy — never written back as a target.
 *
 * See docs/brain/libraries/director-kpis.md · docs/brain/specs/director-kpi-sdk.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { listSpecs } from "@/lib/specs-table";

/** Half-open trailing window in ISO timestamps — `.gte(startIso).lt(endIso)` (the standard
 *  agent_jobs.updated_at window used by director-recap; platform-scorecard's inclusive-end callers
 *  pass the next-day boundary to match). */
export interface ShippedSpecsWindow {
  startIso: string;
  endIso: string;
}

export interface ShippedSpecsByOwnerResult {
  /** merged builds per owner function slug — folded specs INCLUDED. Only owners with ≥1 merged
   *  spec appear (a zero-owner is elided; the caller can fill it as needed). */
  countsByOwner: Record<string, number>;
  /** merged spec slugs per owner — deterministic within a given window (DB-ordered by updated_at
   *  as the query returns). Empty owners are elided. */
  slugsByOwner: Record<string, string[]>;
}

/**
 * Count merged spec builds attributed to their owner function over a trailing window, using the
 * FULL spec set (`listSpecs(workspaceId)`) so folded specs still map to their owner. When `owner`
 * is provided the result is restricted to that single owner (still returned as maps for the same
 * shape — the caller reads `result.countsByOwner[owner] ?? 0`).
 *
 * The merged-build population is `agent_jobs kind='build' status='merged'` with `updated_at`
 * (the merge flip) in the window. A row whose `spec_slug` is null or doesn't resolve against
 * `listSpecs` is dropped (no owner to attribute to).
 */
export async function shippedSpecsByOwner(
  workspaceId: string,
  window: ShippedSpecsWindow,
  owner?: string,
): Promise<ShippedSpecsByOwnerResult> {
  const admin = createAdminClient();

  const specs = await listSpecs(workspaceId);
  const { data, error } = await admin
    .from("agent_jobs")
    .select("spec_slug")
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .eq("status", "merged")
    .gte("updated_at", window.startIso)
    .lt("updated_at", window.endIso);
  if (error) throw error;

  return rollupShippedSpecsByOwner(
    specs.map((s) => ({ slug: s.slug, owner: s.owner })),
    ((data ?? []) as Array<{ spec_slug: string | null }>).map((r) => r.spec_slug),
    owner,
  );
}

/**
 * Pure roll-up: given a (slug, owner) list from `listSpecs` and the `spec_slug` column of merged
 * `agent_jobs` rows in-window, compute the per-owner shipped count + slug list. Exported for unit
 * tests + any caller that already has the raw shapes in hand. Folded specs are just regular rows
 * in `specSet` — that's the whole point.
 */
export function rollupShippedSpecsByOwner(
  specSet: ReadonlyArray<{ slug: string; owner: string | null }>,
  mergedSpecSlugs: ReadonlyArray<string | null>,
  owner?: string,
): ShippedSpecsByOwnerResult {
  const ownerBySpec = new Map<string, string>();
  for (const s of specSet) if (s.owner) ownerBySpec.set(s.slug, s.owner);

  const countsByOwner: Record<string, number> = {};
  const slugsByOwner: Record<string, string[]> = {};
  for (const slug of mergedSpecSlugs) {
    if (!slug) continue;
    const ownerFn = ownerBySpec.get(slug);
    if (!ownerFn) continue;
    if (owner && ownerFn !== owner) continue;
    countsByOwner[ownerFn] = (countsByOwner[ownerFn] ?? 0) + 1;
    (slugsByOwner[ownerFn] ??= []).push(slug);
  }
  return { countsByOwner, slugsByOwner };
}
