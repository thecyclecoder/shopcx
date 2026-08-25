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
import { type Seed } from "@/lib/competitor-ad-types";
import { hasAdLibraryAccess } from "@/lib/meta-ad-library";
import { enqueueCreativeScoutJob } from "@/lib/ads/creative-scout-job";
import {
  loadApprovedCompetitorsForProduct,
  productsWithApprovedCompetitors,
  promoteWhitelistedPages,
  normalizeBrand,
} from "@/lib/competitors";
import {
  sweepCompetitorLanes,
  filterSeedsByFreshness,
  adlibraryFreshnessDays,
  type IngestResult,
} from "@/lib/creative-skeleton";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { syncResearchUrlsFromCreatives } from "@/lib/research-urls";
import { enqueueImitationQualityReview } from "@/lib/ads/imitation-quality-review";

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

async function safeSweep(
  workspaceId: string,
  seed: Seed,
  approvedAdvertisers: Set<string>,
): Promise<IngestResult> {
  try {
    // winners-flow (Phase 2b): two-lane collection — LANE A (name→pageId→winners scan) or LANE B
    // (domain search), routed by resolveAdvertiser. The seed's `expectedDomain` enables LANE B.
    // `approvedAdvertisers` is the persist-time guard: only ads whose advertiser normalizes to an
    // approved competitor of THIS product survive (drops LANE-B affiliate leakage like Creamer's
    // "Healthy Habits" / "A Path to Better Health").
    const r = await sweepCompetitorLanes(workspaceId, seed, {
      domain: seed.expectedDomain,
      approvedAdvertisers,
    });
    if (!r.lane) {
      console.warn(
        `[creative-scout] BAD SEED "${seed.keyword}" — neither name nor domain resolved to a Meta advertiser`,
      );
    } else if (r.transientEmptyPull) {
      // The spec's "silent per-competitor drop" fingerprint: brand resolved to a lane but the
      // AdLibrary pull (winners + keyword + domain fallbacks) returned 0 statics. Surface loudly
      // (an operator needs to see the resolved name so a truly stopped brand vs a transient dip
      // is distinguishable). No retire happened.
      console.warn(
        `[creative-scout] "${seed.keyword}" → LANE ${r.lane.toUpperCase()}${r.resolvedName ? ` (${r.resolvedName})` : ""}: resolved but AdLibrary returned 0 statics across winners + keyword + domain fallbacks — TRANSIENT EMPTY PULL (skipping retire to protect existing skeletons).`,
      );
    } else {
      // Source records which AdLibrary path actually fed the ingest: `winners` (LANE A's scan,
      // preferred), `keyword` (LANE A's winners were empty → keyword searchAds fallback), or
      // `domain` (either LANE B's domain search, or LANE A's keyword-empty → domain fallback).
      // The Obvi/NativePath/Vital Proteins fingerprint is a `keyword`- or `domain`-source line
      // where the winners-preferred brand still ingested via the fallback (spec 2026-07-19).
      console.log(
        `[creative-scout] "${seed.keyword}" → LANE ${r.lane.toUpperCase()}${r.resolvedName ? ` (${r.resolvedName})` : ""} · source=${r.source ?? "none"}: ${r.searched} pulled, ${r.inserted} new, ${r.reobserved} re-observed (persistence++), ${r.retired} retired, ${r.nonMappedDropped} non-mapped-dropped`,
      );
    }
    return r;
  } catch (err) {
    console.error(`[creative-scout] sweep failed for ${seed.keyword}:`, err);
    return { ...emptyTotals(), failed: 1 };
  }
}

/**
 * The persist-time approved-advertiser SET for a product: every approved competitor's `search_keyword`
 * (or fallback `brand`) plus `expectedAdvertiser` (resolved_advertiser fallback), all `normalizeBrand`-
 * flattened. An ingest ad's `advertiser` must normalize into this set or it's dropped. Built from the
 * SAME `loadApprovedCompetitorsForProduct` result the sweep iterates, so freshness-skipped seeds still
 * count as approved advertisers (a competitor searched last week is still a competitor this week).
 * Exported for tests.
 */
export function buildApprovedAdvertiserSet(seeds: Seed[]): Set<string> {
  const set = new Set<string>();
  for (const s of seeds) {
    if (s.keyword) set.add(normalizeBrand(s.keyword));
    if (s.expectedAdvertiser) set.add(normalizeBrand(s.expectedAdvertiser));
  }
  set.delete("");
  return set;
}

/** Freshness-gate one product's competitor seeds (unless forced): drop brands pulled inside the window so
 *  re-runs don't burn quota. Returns the kept seeds + how many were skipped + the FULL approved-advertiser
 *  list (both freshness-passed AND freshness-skipped) — the guard set must cover every approved competitor
 *  of the product, not just this run's seeds. Plain (no step) — the caller wraps it in a step. */
async function keptSeedsForProduct(
  workspaceId: string,
  productId: string,
  force: boolean,
): Promise<{ kept: Seed[]; skipped: number; approvedAdvertisers: string[] }> {
  const seeds = await loadApprovedCompetitorsForProduct(workspaceId, productId);
  // The approved-advertiser guard set: derived from ALL approved competitors of the product (not just
  // freshness-passed). Arrays serialize across step.run — the caller rehydrates into a Set.
  const approvedAdvertisers = Array.from(buildApprovedAdvertiserSet(seeds));
  if (!seeds.length || force) return { kept: seeds, skipped: 0, approvedAdvertisers };
  const gated = await filterSeedsByFreshness(workspaceId, seeds, adlibraryFreshnessDays());
  return { kept: gated.kept, skipped: gated.skipped.length, approvedAdvertisers };
}

type StepTools = GetStepTools<typeof inngest>;

/**
 * Dispatch one BOX job per product-with-approved-competitors for a workspace.
 *
 * ── WHY THIS NO LONGER SWEEPS INLINE ────────────────────────────────────────────────────
 * It used to call `sweepCompetitorLanes` right here, throttled 7s apart to stay under AdLibrary's
 * 10-searches/min cap. Both halves of that are now obsolete:
 *   • Meta creative bytes require a browser render, which Vercel cannot do — see
 *     [[@/lib/ads/creative-scout-job]] for the Vercel-discovers / box-renders split.
 *   • There is no per-search credit to conserve. The Meta archive is free, so the throttle that
 *     existed to protect a paid quota protects nothing.
 *
 * What stays on Vercel is the DECISION: which workspaces, which products, and whether the freshness
 * gate lets a product through. The box does collect → render → vision → persist.
 *
 * Note the totals shape changed: this function can no longer report `inserted`/`searched`, because
 * the work hasn't happened yet when it returns. It reports what it QUEUED. The per-run ingest
 * numbers are recorded by the box job.
 */
async function dispatchWorkspace(
  step: StepTools,
  workspaceId: string,
  force: boolean,
  onlyProductId?: string,
): Promise<{ products: number; queued: number; skipped: number; alreadyInflight: number }> {
  const productIds = onlyProductId
    ? [onlyProductId]
    : await step.run(`products-${workspaceId}`, () => productsWithApprovedCompetitors(workspaceId));

  let queued = 0;
  let skipped = 0;
  let alreadyInflight = 0;

  for (const productId of productIds) {
    const { kept, skipped: gatedOut } = await step.run(
      `seeds-${workspaceId}-${productId}`,
      () => keptSeedsForProduct(workspaceId, productId, force),
    );
    skipped += gatedOut;
    // Every competitor freshness-gated out ⇒ nothing to scout for this product this run.
    if (!kept.length) continue;

    const r = await step.run(`enqueue-scout-${workspaceId}-${productId}`, () =>
      enqueueCreativeScoutJob({ workspaceId, productId, force }),
    );
    if (r.enqueued) queued++;
    else if (r.reason === "already_inflight") alreadyInflight++;
  }

  return { products: productIds.length, queued, skipped, alreadyInflight };
}

export const creativeScoutWeeklyCron = inngest.createFunction(
  { id: "creative-scout-weekly-cron", retries: 1, triggers: [{ cron: "0 9 * * 1" }] },
  async ({ step }) => {
    const result = await (async () => {
      const workspaceIds = await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, products: 0, queued: 0 };

      let productCount = 0;
      let queued = 0;
      let totalSkipped = 0;
      let inflight = 0;
      let noAccess = 0;
      for (const workspaceId of workspaceIds) {
        // Access is PER-WORKSPACE now: /ads_archive answers only to that workspace's ID-confirmed
        // user token, so a workspace that hasn't connected Meta is skipped individually rather than
        // the whole cron short-circuiting on one missing env var.
        const ok = await step.run(`meta-access-${workspaceId}`, () => hasAdLibraryAccess(workspaceId));
        if (!ok) { noAccess++; continue; }
        const r = await dispatchWorkspace(step, workspaceId, false);
        productCount += r.products;
        queued += r.queued;
        totalSkipped += r.skipped;
        inflight += r.alreadyInflight;
      }
      return {
        workspaces: workspaceIds.length,
        products: productCount,
        queued,
        skipped: totalSkipped,
        alreadyInflight: inflight,
        noMetaAccess: noAccess,
        freshnessDays: adlibraryFreshnessDays(),
      };
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
    const data = event.data as { workspaceId?: string; productId?: string; force?: boolean } | undefined;
    // Explicit user action = intentional spend — force=true BYPASSES the freshness gate (re-scout now).
    const force = data?.force === true;

    const workspaceIds = data?.workspaceId ? [data.workspaceId] : await step.run("ad-tool-workspaces", adToolWorkspaceIds);
    if (!workspaceIds.length) return { workspaces: 0, products: 0, queued: 0, forced: force };

    let productCount = 0;
    let queued = 0;
    let totalSkipped = 0;
    let inflight = 0;
    let noAccess = 0;
    for (const workspaceId of workspaceIds) {
      const ok = await step.run(`meta-access-${workspaceId}`, () => hasAdLibraryAccess(workspaceId));
      if (!ok) { noAccess++; continue; }
      // A single-product on-demand scout when productId is given; else every product in the
      // workspace that has approved competitors.
      const r = await dispatchWorkspace(step, workspaceId, force, data?.productId);
      productCount += r.products;
      queued += r.queued;
      totalSkipped += r.skipped;
      inflight += r.alreadyInflight;
    }
    return {
      workspaces: workspaceIds.length,
      products: productCount,
      queued,
      skipped: totalSkipped,
      alreadyInflight: inflight,
      noMetaAccess: noAccess,
      forced: force,
      freshnessDays: adlibraryFreshnessDays(),
    };
  },
);
