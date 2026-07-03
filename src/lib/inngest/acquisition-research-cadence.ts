/**
 * Acquisition Research Cadence — the standing re-scan loop + the gap→outcome grading sweep
 * (docs/brain/specs/acquisition-research-loop-grading.md, Phase 1; M5 of the Acquisition Research
 * Engine, docs/brain/goals/acquisition-research-engine.md).
 *
 * Makes the engine CONSTANT research, not one-shot. Runs daily (offset AFTER the 9am creative-finder
 * sweep so it reasons over fresh creative_skeletons), and for every ad-tool workspace:
 *   1. promote — heavy advertisers that recurred in the fresh sweep surface as 'proposed' competitors
 *                (competitor-scout promoteFromCategorySweep; idempotent / deduped).
 *   2. ad gaps — re-materialize the deterministic ad-gap report into ad_gap_recommendations as
 *                'proposed' (idempotent on dedup_key; SUPPRESSED types are skipped — the loop learns).
 *   3. lander  — fire ads/landing-page-scout.analyze so the Landing Page Scout re-surfaces NEW lander
 *                gaps from the latest snapshots (deduped; suppressed types skipped). The per-chapter
 *                CAPTURE itself is the box script scripts/landing-page-snapshot.ts (Playwright can't
 *                run in serverless) — this loop keeps the ANALYSIS fresh against whatever's captured.
 *   4. grade   — gradeActedGaps: grade each acted-on gap (approved | rejected) 1–10 and revise-grade
 *                ones whose outcome resolved (won | lost). The grade trains step 2 + 3's surfacing.
 *
 * North-star: every step is read/propose only or human-gated — the scouts PROPOSE, the owner approves,
 * the Growth-director grade tunes what's surfaced. Nothing here auto-routes or auto-approves.
 *
 * Triggers:
 *   cron "0 10 * * *"                          → daily re-scan + grade across all ad-tool workspaces
 *   event "ads/acquisition-research.cadence" { workspaceId? } → manual / on-demand
 *
 * See docs/brain/inngest/acquisition-research-cadence.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { promoteFromCategorySweep, promoteWhitelistedPages } from "@/lib/competitors";
import { materializeAdGaps } from "@/lib/acquisition-hub";
import { pickGapGradeBatch } from "@/lib/acquisition-gap-grader";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

async function adToolWorkspaceIds(): Promise<string[]> {
  const admin = createAdminClient();
  // Workspaces that actually use the ad tool (have campaigns) — same scope as the creative-finder cron.
  const { data } = await admin.from("ad_campaigns").select("workspace_id");
  return Array.from(new Set((data || []).map((r) => r.workspace_id as string)));
}

interface WorkspaceCadenceResult {
  workspaceId: string;
  promoted: number;
  /** Whitelisted-page candidates proposed this beat (source='whitelisted', status='proposed'). */
  promotedWhitelisted: number;
  adGaps: number;
  /**
   * grading-cascade-to-box-sessions Phase 4: the inline API grader is gone. `considered` is the
   * batch size picked by pickGapGradeBatch (0 = nothing to grade); `enqueued` is 1 when we
   * dispatched a `gap-grade` box job for this workspace this beat, 0 when dedup skipped (already
   * an in-flight `gap-grade` job for this workspace). Actual grades land on the box within a few
   * minutes.
   */
  graded: { considered: number; enqueued: number };
  /**
   * rhea-url-sensor Phase 2: 1 when we dispatched a `research` box job for this workspace this
   * beat, 0 when dedup skipped (already an in-flight `research` job) or the workspace has no
   * unreviewed research_urls to classify. Actual classifications land on the box within tens of
   * minutes (a per-URL Playwright capture + a single Max classify pass).
   */
  research: { unreviewed: number; enqueued: number };
}

/** One workspace's re-scan + grade pass. Best-effort per step — a failure never breaks the loop. */
async function runWorkspaceCadence(workspaceId: string): Promise<WorkspaceCadenceResult> {
  let promoted = 0;
  let promotedWhitelisted = 0;
  let adGaps = 0;
  const graded = { considered: 0, enqueued: 0 };
  const research = { unreviewed: 0, enqueued: 0 };

  try {
    const p = await promoteFromCategorySweep(workspaceId);
    promoted = p.promoted;
  } catch (err) {
    console.error(`[acquisition-cadence] promote failed ws=${workspaceId}:`, err);
  }

  try {
    const p = await promoteWhitelistedPages(workspaceId);
    promotedWhitelisted = p.promoted;
  } catch (err) {
    console.error(`[acquisition-cadence] promote-whitelisted failed ws=${workspaceId}:`, err);
  }

  try {
    const report = await materializeAdGaps(workspaceId);
    adGaps = report.recommendations.length;
  } catch (err) {
    console.error(`[acquisition-cadence] ad-gap materialize failed ws=${workspaceId}:`, err);
  }

  // Grading is dispatched box-side (grading-cascade-to-box-sessions Phase 4). Pick the batch
  // here (a cheap DB read) and enqueue ONE `gap-grade` `agent_jobs` row per batch-ready workspace
  // carrying the picked candidates. The box's gap-grade lane (scripts/builder-worker.ts →
  // runGapGradeJob) then reads each gap + its routed outcome and writes acquisition_gap_grades
  // via applyBoxGapGrade (same UNIQUE(workspace_id, gap_source, gap_id) upsert + human-override
  // invariant as the deployed gradeGap path). Dedup: skip re-enqueueing while a `gap-grade` job
  // for this workspace is already queued/building. Best-effort.
  try {
    const admin = createAdminClient();
    const batch = await pickGapGradeBatch({ workspaceId, admin });
    if (batch.length) {
      graded.considered = batch.length;
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "gap-grade")
        .in("status", ["queued", "queued_resume", "building", "claimed"])
        .limit(1);
      if (inflight && inflight.length) {
        graded.enqueued = 1; // already dispatched on a prior beat — grading IS flowing box-side
      } else {
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: workspaceId,
          spec_slug: "gap-grade",
          kind: "gap-grade",
          status: "queued",
          created_by: null,
          instructions: JSON.stringify({ candidates: batch }),
        });
        if (!error) graded.enqueued = 1;
        else console.error(`[acquisition-cadence] gap-grade enqueue failed ws=${workspaceId}: ${error.message}`);
      }
    }
  } catch (err) {
    console.error(`[acquisition-cadence] gap-grade pick/enqueue failed ws=${workspaceId}:`, err);
  }

  // rhea-url-sensor Phase 2: enqueue Rhea's URL sensor for any workspace with unreviewed
  // research_urls, dedup-gated like gap-grade above. The box lane (scripts/builder-worker.ts →
  // runResearchJob) captures + classifies up to RESEARCH_BATCH_CAP unreviewed URLs per pass.
  // Idempotent — if there's already an in-flight `research` job for this workspace we skip.
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("research_urls")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("teardown_verdict", "unreviewed");
    research.unreviewed = count ?? 0;
    if (research.unreviewed > 0) {
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "research")
        .in("status", ["queued", "queued_resume", "building", "claimed"])
        .limit(1);
      if (inflight && inflight.length) {
        research.enqueued = 1; // already dispatched on a prior beat — classification IS flowing box-side
      } else {
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: workspaceId,
          spec_slug: "research",
          kind: "research",
          status: "queued",
          created_by: null,
        });
        if (!error) research.enqueued = 1;
        else console.error(`[acquisition-cadence] research enqueue failed ws=${workspaceId}: ${error.message}`);
      }
    }
  } catch (err) {
    console.error(`[acquisition-cadence] research pick/enqueue failed ws=${workspaceId}:`, err);
  }

  return { workspaceId, promoted, promotedWhitelisted, adGaps, graded, research };
}

export const acquisitionResearchCadenceCron = inngest.createFunction(
  { id: "acquisition-research-cadence-cron", retries: 1, triggers: [{ cron: "0 10 * * *" }] },
  async ({ step }) => {
    const result = await (async () => {
      const workspaceIds = await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, results: [] as WorkspaceCadenceResult[] };

      const results: WorkspaceCadenceResult[] = [];
      for (const workspaceId of workspaceIds) {
        const r = await step.run(`cadence-${workspaceId}`, () => runWorkspaceCadence(workspaceId));
        results.push(r);
        // Re-surface NEW lander gaps from the latest snapshots (deduped; suppressed types skipped).
        await step.sendEvent(`lander-analyze-${workspaceId}`, {
          name: "ads/landing-page-scout.analyze",
          data: { workspaceId },
        });
      }
      return { workspaces: workspaceIds.length, results };
    })();

    // Control Tower: end-of-run heartbeat (a healthy-but-idle cron must still beat).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("acquisition-research-cadence-cron", { ok: true, produced: result });
    });

    return result;
  },
);

export const acquisitionResearchCadenceManual = inngest.createFunction(
  { id: "acquisition-research-cadence-manual", retries: 1, triggers: [{ event: "ads/acquisition-research.cadence" }] },
  async ({ event, step }) => {
    const wsArg = (event.data as { workspaceId?: string } | undefined)?.workspaceId;
    const workspaceIds = wsArg ? [wsArg] : await step.run("ad-tool-workspaces", adToolWorkspaceIds);
    if (!workspaceIds.length) return { workspaces: 0, results: [] as WorkspaceCadenceResult[] };

    const results: WorkspaceCadenceResult[] = [];
    for (const workspaceId of workspaceIds) {
      const r = await step.run(`cadence-${workspaceId}`, () => runWorkspaceCadence(workspaceId));
      results.push(r);
      await step.sendEvent(`lander-analyze-${workspaceId}`, {
        name: "ads/landing-page-scout.analyze",
        data: { workspaceId },
      });
    }
    return { workspaces: workspaceIds.length, results };
  },
);
