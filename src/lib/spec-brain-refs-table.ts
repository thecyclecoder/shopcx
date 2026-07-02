/**
 * spec-brain-refs-table — the SDK write/read surface for `public.spec_brain_refs`
 * ([[../tables/spec_brain_refs]]), the structured replacement for the `**Brain refs:**` prose line
 * (pm-structured-intent-and-refs Phase 2).
 *
 * A spec (or one of its phases) points at N brain pages — one row per (spec_id | phase_id →
 * `brain_slug`). `phase_id=NULL` means a spec-level ref; a per-phase ref names its phase. The
 * `brain_slug` is the canonical `kind/name` path relative to `docs/brain/` (e.g. `libraries/author-spec`).
 * Populated at authoring time by [[brain-ref-suggest]] (the existing suggester); the CI enforcer
 * [[../scripts/_check-brain-refs.ts]] validates every slug resolves to a real
 * `docs/brain/{kind}/{name}.md` on disk — a dangling ref fails CI.
 *
 * Reverse lookup: `specsTouchingBrainPage(brain_slug)` returns every spec that references a given
 * brain page (the "which specs touch this page" query the roadmap surfaces).
 *
 * Service-role only (RLS allows read for authenticated; ALL ops for service_role). All callers go
 * through `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface SpecBrainRefRow {
  id: string;
  spec_id: string;
  /** null → spec-level ref (applies to the whole spec); non-null → per-phase ref. */
  phase_id: string | null;
  /** Canonical `kind/name` path relative to `docs/brain/` (e.g. `libraries/author-spec`). */
  brain_slug: string;
  created_at: string;
  updated_at: string;
}

export interface SpecBrainRefInput {
  /** null → spec-level ref; a phase id → per-phase ref. */
  phase_id: string | null;
  brain_slug: string;
}

/**
 * Replace a spec's brain refs — the sanctioned "author's picks WIN" writer. Deletes every existing
 * ref for `spec_id` and inserts `refs`. Idempotent: re-running with the same input produces the same
 * row set (a stable dedup index on (spec_id, coalesce(phase_id,''), brain_slug) rejects any dupes an
 * author might pass by mistake).
 *
 * Called by the author chokepoint AFTER the spec write lands (the FK needs the spec row to exist).
 * Empty `refs` is fine: it clears the row set for that spec.
 */
export async function replaceSpecBrainRefs(
  specId: string,
  refs: SpecBrainRefInput[],
): Promise<void> {
  const admin = createAdminClient();
  const { error: delErr } = await admin
    .from("spec_brain_refs")
    .delete()
    .eq("spec_id", specId);
  if (delErr) throw delErr;
  if (!refs.length) return;
  const rows = refs.map((r) => ({
    spec_id: specId,
    phase_id: r.phase_id,
    brain_slug: r.brain_slug,
  }));
  const { error: insErr } = await admin.from("spec_brain_refs").insert(rows);
  if (insErr) throw insErr;
}

/**
 * List every brain ref for a spec — spec-level (phase_id=null) + per-phase. Ordered by phase_id
 * (nulls first) then brain_slug for a stable render.
 */
export async function listSpecBrainRefs(specId: string): Promise<SpecBrainRefRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_brain_refs")
    .select("id, spec_id, phase_id, brain_slug, created_at, updated_at")
    .eq("spec_id", specId)
    .order("phase_id", { ascending: true, nullsFirst: true })
    .order("brain_slug", { ascending: true });
  if (error) throw error;
  return (data as SpecBrainRefRow[]) ?? [];
}

/**
 * Reverse lookup — every spec that references a given brain page (`brain_slug`). Returns the
 * distinct spec_ids + count of refs (a per-phase ref counts as one). Used by the roadmap "which
 * specs touch this brain page" surface.
 *
 * Sorted by spec_id for a stable order.
 */
export async function specsTouchingBrainPage(brainSlug: string): Promise<{ spec_id: string; ref_count: number }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_brain_refs")
    .select("spec_id")
    .eq("brain_slug", brainSlug);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const r of (data as { spec_id: string }[]) ?? []) {
    counts.set(r.spec_id, (counts.get(r.spec_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([spec_id, ref_count]) => ({ spec_id, ref_count }))
    .sort((a, b) => a.spec_id.localeCompare(b.spec_id));
}

/**
 * Parse a `**Brain refs:**` line body (e.g. `[[../libraries/foo]] · [[../inngest/bar]]`) into the
 * canonical `{kind}/{name}` slugs the DB expects. Case-insensitive on the kind + slug, strips the
 * relative `../` prefix + any alias segment. Returns an empty list if the line is empty / carries no
 * recognizable wikilinks.
 */
export function parseBrainRefsLineToSlugs(line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of line.matchAll(/\[\[(?:\.\.\/)?([a-z]+)\/([a-z0-9_\-]+)(?:\.md)?(?:\|[^\]]+)?\]\]/gi)) {
    const slug = `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}
