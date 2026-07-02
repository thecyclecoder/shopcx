/**
 * Winning Static-Creative Finder — daily sweep cron + manual trigger.
 *
 * Once a day, for every workspace that uses the ad tool, pull long-running
 * competitor + category ads from AdLibrary.com (curated seeds), vision-deconstruct
 * each static into a skeleton, and route videos aside for the Phase 6 pipeline.
 * Repetition of a slot across multiple INDEPENDENT brands is the signal — the
 * Phase 4 pattern matrix aggregates these skeletons on demand.
 *
 * Rate limits (AdLibrary: 10 searches/min): we step.sleep ~7s between seed
 * searches so a single sweep stays comfortably under the cap. Dedup by `ad_key`
 * means re-runs don't re-spend credits or vision tokens.
 *
 * Triggers:
 *   cron "0 9 * * *"               → daily sweep across all ad-tool workspaces
 *   event "ads/creative-finder.sweep" { workspaceId? } → manual / on-demand
 *
 * See docs/brain/specs/winning-static-creative-finder.md + docs/brain/inngest/creative-finder.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasAdLibraryKey, CATEGORY_SEEDS, type Seed } from "@/lib/adlibrary";
import {
  loadApprovedCompetitorSeeds,
  promoteFromCategorySweep,
  promoteWhitelistedPages,
} from "@/lib/competitors";
import { sweepSeed, type IngestResult } from "@/lib/creative-skeleton";
import { hasFfmpeg, processVideoPending, type VideoProcessResult } from "@/lib/video-skeleton";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const SWEEP_DELAY_MS = 7000; // ~8 searches/min — under AdLibrary's 10/min cap

async function adToolWorkspaceIds(): Promise<string[]> {
  const admin = createAdminClient();
  // Workspaces that actually use the ad tool (have campaigns). Avoids spending
  // shared global credits sweeping for tenants who don't run ads.
  const { data } = await admin.from("ad_campaigns").select("workspace_id");
  return Array.from(new Set((data || []).map((r) => r.workspace_id as string)));
}

/**
 * Per-workspace sweep seeds: the DB-driven APPROVED competitor brands (competitor-scout) +
 * the curated CATEGORY_SEEDS. Competitor brands are NEVER hardcoded — a workspace with no
 * approved competitors runs only its category keywords (no hardcoded fallback list).
 */
async function workspaceSeeds(workspaceId: string): Promise<Seed[]> {
  const competitors = await loadApprovedCompetitorSeeds(workspaceId);
  return [...competitors, ...CATEGORY_SEEDS];
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

export const creativeFinderDailyCron = inngest.createFunction(
  { id: "creative-finder-daily-cron", retries: 1, triggers: [{ cron: "0 9 * * *" }] },
  async ({ step }) => {
    // Compute the run result on every path (incl. no-key / no-workspace skips)
    // so the end-of-run heartbeat below always fires — a healthy-but-idle cron
    // must still beat, or Control Tower false-flags it registered_not_firing.
    const result = await (async () => {
      if (!hasAdLibraryKey()) return { skipped: "no_adlibrary_key" };
      const workspaceIds = await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, totals: emptyTotals() };

      let totals = emptyTotals();
      for (const workspaceId of workspaceIds) {
        const seeds = await step.run(`seeds-${workspaceId}`, () => workspaceSeeds(workspaceId));
        for (let i = 0; i < seeds.length; i++) {
          const seed = seeds[i];
          const r = await step.run(`sweep-${workspaceId}-${seed.keyword}`, () => safeSweep(workspaceId, seed));
          totals = addTotals(totals, r);
          if (i < seeds.length - 1) await step.sleep(`throttle-${workspaceId}-${i}`, SWEEP_DELAY_MS);
        }
        // Category-sweep promotion (competitor-scout): heavy advertisers that recurred in this
        // workspace's sweep output surface as 'proposed' competitors for owner approval.
        await step.run(`promote-${workspaceId}`, () => promoteFromCategorySweep(workspaceId));
        // Whitelisted-page promotion: affiliate/advertorial/creator pages fronting a KNOWN
        // competitor (destination_domain join) surface as 'proposed' whitelisted rows.
        await step.run(`promote-whitelisted-${workspaceId}`, () => promoteWhitelistedPages(workspaceId));
      }
      return { workspaces: workspaceIds.length, totals };
    })();

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("creative-finder-daily-cron", { ok: true, produced: result });
    });

    return result;
  },
);

export const creativeFinderManualSweep = inngest.createFunction(
  { id: "creative-finder-manual-sweep", retries: 1, triggers: [{ event: "ads/creative-finder.sweep" }] },
  async ({ event, step }) => {
    if (!hasAdLibraryKey()) return { skipped: "no_adlibrary_key" };
    const wsArg = (event.data as { workspaceId?: string } | undefined)?.workspaceId;
    const workspaceIds = wsArg ? [wsArg] : await step.run("ad-tool-workspaces", adToolWorkspaceIds);
    if (!workspaceIds.length) return { workspaces: 0, totals: emptyTotals() };

    let totals = emptyTotals();
    for (const workspaceId of workspaceIds) {
      const seeds = await step.run(`seeds-${workspaceId}`, () => workspaceSeeds(workspaceId));
      for (let i = 0; i < seeds.length; i++) {
        const seed = seeds[i];
        const r = await step.run(`sweep-${workspaceId}-${seed.keyword}`, () => safeSweep(workspaceId, seed));
        totals = addTotals(totals, r);
        if (i < seeds.length - 1) await step.sleep(`throttle-${workspaceId}-${i}`, SWEEP_DELAY_MS);
      }
      await step.run(`promote-${workspaceId}`, () => promoteFromCategorySweep(workspaceId));
      await step.run(`promote-whitelisted-${workspaceId}`, () => promoteWhitelistedPages(workspaceId));
    }
    return { workspaces: workspaceIds.length, totals };
  },
);

async function safeSweep(workspaceId: string, seed: Seed): Promise<IngestResult> {
  try {
    return await sweepSeed(workspaceId, seed);
  } catch (err) {
    console.error(`[creative-finder] sweep failed for ${seed.keyword}:`, err);
    return { ...emptyTotals(), failed: 1 };
  }
}

// ── creative-finder-video Phase 1 — process parked video_pending creatives ──────

function emptyVideoTotals(): VideoProcessResult {
  return { pending: 0, analyzed: 0, failed: 0, bytesDownloaded: 0, whisperCents: 0 };
}

function addVideoTotals(a: VideoProcessResult, b: VideoProcessResult): VideoProcessResult {
  return {
    pending: a.pending + b.pending,
    analyzed: a.analyzed + b.analyzed,
    failed: a.failed + b.failed,
    bytesDownloaded: a.bytesDownloaded + b.bytesDownloaded,
    whisperCents: a.whisperCents + b.whisperCents,
  };
}

async function safeProcessVideos(workspaceId: string, max?: number): Promise<VideoProcessResult> {
  try {
    return await processVideoPending(workspaceId, { max });
  } catch (err) {
    console.error(`[creative-finder-video] process failed for ${workspaceId}:`, err);
    return { ...emptyVideoTotals(), failed: 1 };
  }
}

/**
 * Heavier video follow-on: download → ffmpeg keyframes + Whisper transcript →
 * same four-slot skeleton, draining each workspace's `video_pending` backlog.
 * Runs after the 9:00 static sweep so newly-parked videos get picked up the same
 * morning. Gated on the AdLibrary key (to download) + an ffmpeg binary (frames);
 * transcription is best-effort inside the pipeline (gates on `hasOpenAiKey()`).
 *
 * Triggers:
 *   cron "30 9 * * *"                  → daily drain across all ad-tool workspaces
 *   event "ads/creative-finder.video" { workspaceId?, max? } → manual / on-demand
 */
export const creativeFinderVideoProcess = inngest.createFunction(
  {
    id: "creative-finder-video-process",
    retries: 1,
    triggers: [{ cron: "30 9 * * *" }, { event: "ads/creative-finder.video" }],
  },
  async ({ event, step }) => {
    const result = await (async () => {
      if (!hasAdLibraryKey()) return { skipped: "no_adlibrary_key" };
      if (!hasFfmpeg()) return { skipped: "no_ffmpeg" };

      const data = event?.data as { workspaceId?: string; max?: number } | undefined;
      const workspaceIds = data?.workspaceId
        ? [data.workspaceId]
        : await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, totals: emptyVideoTotals() };

      let totals = emptyVideoTotals();
      for (const workspaceId of workspaceIds) {
        const r = await step.run(`videos-${workspaceId}`, () => safeProcessVideos(workspaceId, data?.max));
        totals = addVideoTotals(totals, r);
      }
      return { workspaces: workspaceIds.length, totals };
    })();

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("creative-finder-video-process", { ok: true, produced: result });
    });

    return result;
  },
);
