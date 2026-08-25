/**
 * Creative-scout BOX runner — collect → render → vision → persist, for one product's competitors.
 *
 * This is the half of the scout that cannot run on Vercel. It owns the Playwright renderer for the
 * whole product (one chromium launch amortized across every competitor's statics — launching per ad
 * is the dominant cost) and hands `sweepCompetitorLanes` a `CreativeFetcher` closed over it.
 *
 * Invoked by `scripts/builder-worker.ts` → `runCreativeScoutJob` for a `kind='creative-scout'`
 * agent_jobs row queued by [[./creative-scout-job]]. Never import this from an Inngest function.
 *
 * See [[../../../docs/brain/integrations/meta-ad-library.md]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  loadApprovedCompetitorsForProduct,
  productsWithApprovedCompetitors,
  promoteWhitelistedPages,
  normalizeBrand,
} from "@/lib/competitors";
import { sweepCompetitorLanes, type CreativeFetcher } from "@/lib/creative-skeleton";
import { CreativeRenderer } from "@/lib/meta-ad-library-render";
import { CreativeRenderError, type NormalizedAd, type Seed } from "@/lib/competitor-ad-types";
import { syncResearchUrlsFromCreatives } from "@/lib/research-urls";
import { enqueueImitationQualityReview } from "@/lib/ads/imitation-quality-review";
import { errText } from "@/lib/error-text";

export interface ScoutRunResult {
  products: number;
  competitors: number;
  searched: number;
  inserted: number;
  reobserved: number;
  failed: number;
  unresolved: string[];
  imitationReviewEnqueued: boolean;
}

/** The approved-advertiser guard set — every brand this product is ALLOWED to ingest ads for. */
function buildApprovedAdvertiserSet(seeds: Seed[]): Set<string> {
  const set = new Set<string>();
  for (const s of seeds) {
    if (s.keyword) set.add(normalizeBrand(s.keyword));
    if (s.expectedAdvertiser) set.add(normalizeBrand(s.expectedAdvertiser));
  }
  set.delete("");
  return set;
}

/**
 * Run the scout for one workspace (optionally one product).
 *
 * The renderer is opened ONCE and closed in `finally`, so a mid-sweep throw can't leak a chromium
 * process on the box — a leaked browser is the failure mode that quietly eats the box's memory.
 */
export async function runCreativeScoutSweep(input: {
  workspaceId: string;
  productId?: string | null;
  force?: boolean;
  /** Max statics visioned per competitor (bounds Opus spend). */
  visionCap?: number;
}): Promise<ScoutRunResult> {
  const { workspaceId } = input;
  const admin = createAdminClient();
  const result: ScoutRunResult = {
    products: 0,
    competitors: 0,
    searched: 0,
    inserted: 0,
    reobserved: 0,
    failed: 0,
    unresolved: [],
    imitationReviewEnqueued: false,
  };

  const productIds = input.productId
    ? [input.productId]
    : await productsWithApprovedCompetitors(workspaceId);
  result.products = productIds.length;
  if (!productIds.length) return result;

  // Scope the post-sweep "what did we just insert" query to THIS run, so a re-review never burns a
  // Max session on skeletons a previous sweep already judged.
  const sweepStartIso = new Date().toISOString();

  const renderer = new CreativeRenderer();
  const fetchCreative: CreativeFetcher = async (ad: NormalizedAd) => {
    if (!ad.creative_url) {
      throw new CreativeRenderError(`no snapshot url for ${ad.ad_key}`, true);
    }
    const rendered = await renderer.render(ad.creative_url);
    return { buffer: rendered.buffer, contentType: rendered.contentType };
  };

  try {
    await renderer.open();

    for (const productId of productIds) {
      const seeds = await loadApprovedCompetitorsForProduct(workspaceId, productId);
      if (!seeds.length) continue;
      const approved = buildApprovedAdvertiserSet(seeds);

      for (const seed of seeds) {
        result.competitors++;
        try {
          const lane = await sweepCompetitorLanes(workspaceId, seed, {
            domain: seed.expectedDomain ?? null,
            visionCap: input.visionCap ?? 12,
            approvedAdvertisers: approved,
            fetchCreative,
          });
          result.searched += lane.searched;
          result.inserted += lane.inserted;
          result.reobserved += lane.reobserved;
          result.failed += lane.failed;
          if (!lane.pageId) result.unresolved.push(seed.keyword);
        } catch (err) {
          // One competitor failing must never abort the product's remaining competitors.
          result.failed++;
          console.error(`[creative-scout] sweep failed for "${seed.keyword}":`, errText(err));
        }
      }
    }
  } finally {
    await renderer.close();
  }

  // Preserved per-workspace side-effects (both keyed off APPROVED competitors).
  try {
    await promoteWhitelistedPages(workspaceId);
  } catch (err) {
    console.error(`[creative-scout] promoteWhitelistedPages failed:`, errText(err));
  }
  try {
    await syncResearchUrlsFromCreatives(workspaceId);
  } catch (err) {
    console.error(`[creative-scout] syncResearchUrlsFromCreatives failed:`, errText(err));
  }

  // Enqueue ONE Max imitation-quality-review over the skeletons THIS run inserted.
  if (result.inserted > 0) {
    try {
      const { data: freshRows } = await admin
        .from("creative_skeletons")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("status", "analyzed")
        .eq("media_type", "static")
        .gte("created_at", sweepStartIso)
        .limit(200);
      const ids = ((freshRows ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (ids.length) {
        const r = await enqueueImitationQualityReview({ workspaceId, skeletonIds: ids });
        result.imitationReviewEnqueued = r.enqueued;
      }
    } catch (err) {
      // Never fail the sweep on a review-enqueue error — the sweep is the load-bearing side-effect.
      console.error(`[creative-scout] imitation-quality-review enqueue failed:`, errText(err));
    }
  }

  return result;
}
