/**
 * Creative-scout job — the Vercel→box handoff for competitor-ad collection.
 *
 * ── WHY A JOB EXISTS AT ALL ──────────────────────────────────────────────────────────────
 * Under AdLibrary the whole sweep ran inline in an Inngest function: a creative was one
 * authenticated HTTP GET, which serverless does fine. Meta's archive publishes NO media url — the
 * only handle is `ad_snapshot_url`, a JS-rendered page — so obtaining creative bytes now needs a
 * real browser, and Playwright lives on the box (`scripts/research-capture.ts`), not on Vercel.
 *
 * The split follows the founder's call (2026-08-24): **Vercel discovers, the box renders.** Vercel
 * keeps the weekly cron and decides WHAT to scout; the box does collect → render → vision → persist
 * as ONE unit per product.
 *
 * ⚠️ The unit is deliberately the whole per-product sweep, not just the render. Splitting discovery
 * from rendering would write `creative_skeletons` rows with no creative and no vision, then complete
 * them later — a partial-row state every downstream reader (Dahlia's `getProvenCompetitorAngles`,
 * the pattern matrix, the imitation-quality review) would have to learn to skip. Keeping the unit
 * whole means a skeleton row is never half-built.
 *
 * See [[../../../docs/brain/integrations/meta-ad-library.md]] · [[../../../docs/brain/inngest/creative-scout.md]].
 */
import { createAdminClient } from "@/lib/supabase/admin";

export const CREATIVE_SCOUT_KIND = "creative-scout" as const;

/**
 * Stable workspace-scoped `agent_jobs.spec_slug` for the creative-scout job. The column is
 * `NOT NULL` (supabase/migrations/20260618120000_agent_jobs.sql), so an omitted value blocks
 * the insert and no scout row ever lands — every enqueue path routes through
 * `enqueueCreativeScoutJob`, so pinning the slug here is the single boundary that keeps the
 * Vercel-side manual + weekly dispatch and the box worker's `agent_jobs_slug_idx` rollups
 * on the same durable bucket ([[../../../docs/brain/inngest/creative-scout.md]]).
 */
export const CREATIVE_SCOUT_SPEC_SLUG = "creative-scout" as const;

export interface CreativeScoutJobInput {
  workspaceId: string;
  /** Scope to one product. Omitted ⇒ every product with approved competitors in the workspace. */
  productId?: string;
  /** Bypass the freshness gate (on-demand re-scout). */
  force?: boolean;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Queue one per-product scout job for the box.
 *
 * Idempotent per (workspace, product): a product that already has a queued/running scout job is NOT
 * re-enqueued, so a cron retry or an on-demand trigger landing during the weekly sweep can't double
 * the render spend on the same competitors.
 *
 * `admin` is injectable so a fake supabase chain can exercise the row shape in tests; production
 * callers omit it and the helper falls back to the real service-role client.
 */
export async function enqueueCreativeScoutJob(
  input: CreativeScoutJobInput,
  admin: Admin = createAdminClient(),
): Promise<{ enqueued: boolean; jobId: string | null; reason?: string }> {
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id, instructions")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", CREATIVE_SCOUT_KIND)
    .in("status", ["queued", "running"])
    .limit(50);

  for (const row of (inflight ?? []) as Array<{ id: string; instructions: string | null }>) {
    try {
      const parsed = JSON.parse(row.instructions ?? "{}") as CreativeScoutJobInput;
      if ((parsed.productId ?? null) === (input.productId ?? null)) {
        return { enqueued: false, jobId: row.id, reason: "already_inflight" };
      }
    } catch {
      /* an unparseable instruction blob shouldn't block a new enqueue */
    }
  }

  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: input.workspaceId,
      spec_slug: CREATIVE_SCOUT_SPEC_SLUG,
      kind: CREATIVE_SCOUT_KIND,
      status: "queued",
      instructions: JSON.stringify({
        workspaceId: input.workspaceId,
        productId: input.productId ?? null,
        force: !!input.force,
      }),
    })
    .select("id")
    .single();

  if (error) throw new Error(`creative-scout enqueue failed: ${error.message}`);
  return { enqueued: true, jobId: (data as { id: string }).id };
}
