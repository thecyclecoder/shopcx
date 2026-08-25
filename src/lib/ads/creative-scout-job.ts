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
 * `agent_jobs.spec_slug` is **NOT NULL** — omitting it fails the insert with
 * `null value in column "spec_slug" ... violates not-null constraint`. It is free text used as a
 * per-kind identity/dedupe key (cf. `ad-creative-trigger`'s `${KIND}:${productId}`), NOT a
 * reference to a real spec row.
 *
 * This is the exact bug the first real Inngest firing caught: the direct-runner tests bypassed the
 * enqueue entirely, so the missing column only surfaced when the cron path ran for real.
 */
export const creativeScoutSlug = (productId?: string | null): string =>
  `${CREATIVE_SCOUT_KIND}:${productId ?? "all-products"}`;

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
  const slug = creativeScoutSlug(input.productId);
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", CREATIVE_SCOUT_KIND)
    .eq("spec_slug", slug)
    .in("status", ["queued", "running"])
    .limit(1);

  const existing = (inflight ?? []) as Array<{ id: string }>;
  if (existing.length) {
    return { enqueued: false, jobId: existing[0].id, reason: "already_inflight" };
  }

  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: input.workspaceId,
      kind: CREATIVE_SCOUT_KIND,
      spec_slug: slug,
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
