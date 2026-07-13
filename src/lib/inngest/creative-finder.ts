/**
 * Creative-finder VIDEO drain — the surviving half of the retired workspace-wide creative-finder.
 *
 * The static/competitor SWEEP that used to live here (daily `0 9 * * *` + `ads/creative-finder.sweep`,
 * CATEGORY_SEEDS + every-competitor-at-once) was RETIRED 2026-07-12 in favor of the deliberate PER-PRODUCT
 * scout ([[creative-scout]] — `ads/creative-scout.sweep`). What remains is the heavier video follow-on:
 * drain each workspace's `video_pending` creative_skeletons (download → ffmpeg keyframes + Whisper transcript
 * → the four-slot skeleton). The scout still PARKS videos as `video_pending` (product-tagged), so this drain
 * keeps analyzing them the same way — the id `creative-finder-video-process` is unchanged so Control Tower's
 * heartbeat tracking is uninterrupted.
 *
 * Triggers:
 *   cron "30 9 * * *"                  → daily drain across all ad-tool workspaces
 *   event "ads/creative-finder.video" { workspaceId?, max? } → manual / on-demand
 *
 * See docs/brain/inngest/creative-finder.md + docs/brain/inngest/creative-scout.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasAdLibraryKey } from "@/lib/adlibrary";
import { hasFfmpeg, processVideoPending, type VideoProcessResult } from "@/lib/video-skeleton";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

async function adToolWorkspaceIds(): Promise<string[]> {
  const admin = createAdminClient();
  // Workspaces that actually use the ad tool (have campaigns). Avoids spending shared global
  // credits/compute on tenants who don't run ads.
  const { data } = await admin.from("ad_campaigns").select("workspace_id");
  return Array.from(new Set((data || []).map((r) => r.workspace_id as string)));
}

// ── creative-finder-video — process parked video_pending creatives ──────────────

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
 * Heavier video follow-on: download → ffmpeg keyframes + Whisper transcript → the same four-slot
 * skeleton, draining each workspace's `video_pending` backlog. Runs after the scout parks new videos so
 * they get picked up promptly. Gated on the AdLibrary key (to download) + an ffmpeg binary (frames);
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
