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
import { promoteFromCategorySweep } from "@/lib/competitors";
import { materializeAdGaps } from "@/lib/acquisition-hub";
import { gradeActedGaps } from "@/lib/acquisition-gap-grader";
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
  adGaps: number;
  graded: { considered: number; initial: number; revised: number };
}

/** One workspace's re-scan + grade pass. Best-effort per step — a failure never breaks the loop. */
async function runWorkspaceCadence(workspaceId: string): Promise<WorkspaceCadenceResult> {
  let promoted = 0;
  let adGaps = 0;
  let graded = { considered: 0, initial: 0, revised: 0 };

  try {
    const p = await promoteFromCategorySweep(workspaceId);
    promoted = p.promoted;
  } catch (err) {
    console.error(`[acquisition-cadence] promote failed ws=${workspaceId}:`, err);
  }

  try {
    const report = await materializeAdGaps(workspaceId);
    adGaps = report.recommendations.length;
  } catch (err) {
    console.error(`[acquisition-cadence] ad-gap materialize failed ws=${workspaceId}:`, err);
  }

  try {
    graded = await gradeActedGaps({ workspaceId });
  } catch (err) {
    console.error(`[acquisition-cadence] grade sweep failed ws=${workspaceId}:`, err);
  }

  return { workspaceId, promoted, adGaps, graded };
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
