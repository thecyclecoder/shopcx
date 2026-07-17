/**
 * Per-product Creative Scout — the deliberate imitate feed (CEO 2026-07-12).
 *
 * Replaces the workspace-wide `creative-finder` sweep (CATEGORY_SEEDS + every-competitor-at-once, no
 * product context). The scout runs PER PRODUCT: for each of our products that has ≥1 APPROVED competitor
 * (`competitors.product_id`), it pulls that product's competitors' long-running ads from AdLibrary, vision-
 * deconstructs the statics into `creative_skeletons` TAGGED with `competitor_id` + `product_id`, and parks
 * videos for the existing video pipeline ([[creative-finder]] `creativeFinderVideoProcess`). Dahlia's
 * `getProvenCompetitorAngles(productId)` then reads exactly that product's shelf — a product imitates only
 * the competitors WE chose for it, not a workspace-wide soup.
 *
 * WHY per-product (Dylan): running one product's ~5 competitors at a time keeps every invocation far under
 * AdLibrary's 10-searches/min cap — the old sweep tried ~30 competitors + categories in one run. The event
 * takes an optional `productId` so a single product can be scouted on demand without touching the others.
 *
 * FULLY DELIBERATE: no CATEGORY_SEEDS, no `promoteFromCategorySweep` (category auto-discovery is dropped —
 * competitors are chosen by hand). We DO preserve the two adjacent per-workspace side-effects the old sweep
 * fed: `promoteWhitelistedPages` (affiliate pages fronting a KNOWN competitor) + `syncResearchUrlsFromCreatives`
 * (Rhea's URL sensor). Both are deliberate (keyed off approved competitors) so they stay.
 *
 * Triggers:
 *   cron "0 9 * * 1"                                      → weekly sweep, all ad-tool workspaces × their products
 *   event "ads/creative-scout.sweep" { workspaceId?, productId?, force? } → per-workspace / per-product / on-demand
 *
 * See docs/brain/inngest/creative-scout.md.
 */
import type { GetStepTools } from "inngest";
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasAdLibraryKey, type Seed } from "@/lib/adlibrary";
import {
  loadApprovedCompetitorsForProduct,
  productsWithApprovedCompetitors,
  promoteWhitelistedPages,
} from "@/lib/competitors";
import {
  sweepCompetitorLanes,
  filterSeedsByFreshness,
  adlibraryFreshnessDays,
  type IngestResult,
} from "@/lib/creative-skeleton";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { syncResearchUrlsFromCreatives } from "@/lib/research-urls";

const SWEEP_DELAY_MS = 7000; // ~8 searches/min — under AdLibrary's 10/min cap

async function adToolWorkspaceIds(): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("ad_campaigns").select("workspace_id");
  return Array.from(new Set((data || []).map((r) => r.workspace_id as string)));
}

function emptyTotals(): IngestResult {
  return { searched: 0, longRunners: 0, inserted: 0, videos: 0, skippedExisting: 0, failed: 0 };
}

function addTotals(a: IngestResult, b: IngestResult): IngestResult {
  return {
    searched: a.searched + b.searched,
    longRunners: a.longRunners + b.longRunners,
    inserted: a.inserted + b.inserted,
    videos: a.videos + b.videos,
    skippedExisting: a.skippedExisting + b.skippedExisting,
    failed: a.failed + b.failed,
  };
}

async function safeSweep(workspaceId: string, seed: Seed): Promise<IngestResult> {
  try {
    // winners-flow (Phase 2b): two-lane collection — LANE A (name→pageId→winners scan) or LANE B
    // (domain search), routed by resolveAdvertiser. The seed's `expectedDomain` enables LANE B.
    const r = await sweepCompetitorLanes(workspaceId, seed, { domain: seed.expectedDomain });
    if (!r.lane) {
      console.warn(`[creative-scout] BAD SEED "${seed.keyword}" — neither name nor domain resolved to a Meta advertiser`);
    } else {
      console.log(`[creative-scout] "${seed.keyword}" → LANE ${r.lane.toUpperCase()}${r.resolvedName ? ` (${r.resolvedName})` : ""}: ${r.inserted} ingested, ${r.skippedExisting} existing`);
    }
    return r;
  } catch (err) {
    console.error(`[creative-scout] sweep failed for ${seed.keyword}:`, err);
    return { ...emptyTotals(), failed: 1 };
  }
}

/** Freshness-gate one product's competitor seeds (unless forced): drop brands pulled inside the window so
 *  re-runs don't burn quota. Returns the kept seeds + how many were skipped. Plain (no step) — the caller
 *  wraps it in a step. */
async function keptSeedsForProduct(
  workspaceId: string,
  productId: string,
  force: boolean,
): Promise<{ kept: Seed[]; skipped: number }> {
  const seeds = await loadApprovedCompetitorsForProduct(workspaceId, productId);
  if (!seeds.length || force) return { kept: seeds, skipped: 0 };
  const gated = await filterSeedsByFreshness(workspaceId, seeds, adlibraryFreshnessDays());
  return { kept: gated.kept, skipped: gated.skipped.length };
}

type StepTools = GetStepTools<typeof inngest>;

/**
 * Sweep every product-with-approved-competitors for one workspace, PRODUCT BY PRODUCT (each product's
 * ~5 competitors at a time — the per-product cadence that keeps every run under AdLibrary's 10/min cap).
 * When `onlyProductId` is set, scopes to that single product (the on-demand per-product path). Then runs
 * the two preserved per-workspace side-effects (whitelisted-page + research-url sync). Throttled 7s/search.
 */
async function sweepWorkspace(
  step: StepTools,
  workspaceId: string,
  force: boolean,
  onlyProductId?: string,
): Promise<{ totals: IngestResult; products: number; skipped: number }> {
  const productIds = onlyProductId
    ? [onlyProductId]
    : await step.run(`products-${workspaceId}`, () => productsWithApprovedCompetitors(workspaceId));

  let totals = emptyTotals();
  let totalSkipped = 0;
  for (const productId of productIds) {
    const { kept, skipped } = await step.run(`seeds-${workspaceId}-${productId}`, () =>
      keptSeedsForProduct(workspaceId, productId, force),
    );
    totalSkipped += skipped;
    for (let i = 0; i < kept.length; i++) {
      const seed = kept[i];
      const r = await step.run(`sweep-${productId}-${seed.keyword}`, () => safeSweep(workspaceId, seed));
      totals = addTotals(totals, r);
      if (i < kept.length - 1) await step.sleep(`throttle-${productId}-${i}`, SWEEP_DELAY_MS);
    }
  }

  // Preserved from the old sweep — both keyed off APPROVED competitors, so they survive the fully-deliberate
  // cut. Category-sweep promotion (auto-discovery) is intentionally gone.
  await step.run(`promote-whitelisted-${workspaceId}`, () => promoteWhitelistedPages(workspaceId));
  await step.run(`sync-research-urls-${workspaceId}`, () => syncResearchUrlsFromCreatives(workspaceId));

  return { totals, products: productIds.length, skipped: totalSkipped };
}

export const creativeScoutWeeklyCron = inngest.createFunction(
  { id: "creative-scout-weekly-cron", retries: 1, triggers: [{ cron: "0 9 * * 1" }] },
  async ({ step }) => {
    const result = await (async () => {
      if (!hasAdLibraryKey()) return { skipped: "no_adlibrary_key" };
      const workspaceIds = await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, products: 0, totals: emptyTotals() };

      let totals = emptyTotals();
      let productCount = 0;
      let totalSkipped = 0;
      for (const workspaceId of workspaceIds) {
        const r = await sweepWorkspace(step, workspaceId, false);
        totals = addTotals(totals, r.totals);
        productCount += r.products;
        totalSkipped += r.skipped;
      }
      return { workspaces: workspaceIds.length, products: productCount, totals, skipped: totalSkipped, freshnessDays: adlibraryFreshnessDays() };
    })();

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("creative-scout-weekly-cron", { ok: true, produced: result });
    });
    return result;
  },
);

export const creativeScoutManualSweep = inngest.createFunction(
  { id: "creative-scout-manual-sweep", retries: 1, triggers: [{ event: "ads/creative-scout.sweep" }] },
  async ({ event, step }) => {
    if (!hasAdLibraryKey()) return { skipped: "no_adlibrary_key" };
    const data = event.data as { workspaceId?: string; productId?: string; force?: boolean } | undefined;
    // Explicit user action = intentional spend — force=true BYPASSES the freshness gate (re-scout now).
    const force = data?.force === true;

    const workspaceIds = data?.workspaceId ? [data.workspaceId] : await step.run("ad-tool-workspaces", adToolWorkspaceIds);
    if (!workspaceIds.length) return { workspaces: 0, products: 0, totals: emptyTotals(), forced: force };

    let totals = emptyTotals();
    let productCount = 0;
    let totalSkipped = 0;
    for (const workspaceId of workspaceIds) {
      // A single-product on-demand scout (the per-product path Dylan asked for) when productId is given;
      // else every product in the workspace that has approved competitors.
      const r = await sweepWorkspace(step, workspaceId, force, data?.productId);
      totals = addTotals(totals, r.totals);
      productCount += r.products;
      totalSkipped += r.skipped;
    }
    return { workspaces: workspaceIds.length, products: productCount, totals, skipped: totalSkipped, forced: force, freshnessDays: adlibraryFreshnessDays() };
  },
);
