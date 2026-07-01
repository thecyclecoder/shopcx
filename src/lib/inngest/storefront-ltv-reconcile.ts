/**
 * Storefront slow-loop actual-LTV reconciler — Inngest functions (Phase 3 of the
 * storefront LTV-proxy reconciler, docs/brain/specs/storefront-ltv-proxy-reconciler.md).
 *
 *   storefront-ltv-reconcile-cron — daily fan-out: finds every workspace with persisted
 *     predicted-LTV metrics and fires one reconcile event each. Offset to 14:00 — AFTER
 *     the M1 attribution refresh (12:00, [[storefront-experiments]]) and the M2 decay
 *     (13:00, [[storefront-lever-decay]]) — so it judges fresh proxy rows.
 *   storefront-ltv-reconcile — per-workspace worker: reconciles each past cohort whose
 *     decision-time snapshot is now ≥ the ~4-month renewal lag old, records proxy-vs-actual
 *     error to [[storefront_ltv_reconciliations]], recalibrates the proxy weights
 *     ([[storefront_ltv_calibration]]), and escalates a large error to Growth.
 *
 * Most days find no newly-mature cohort and the run is a cheap no-op (idempotent — a
 * cohort reconciles exactly once). The heavy lifting lives in [[storefront-ltv-reconciler]];
 * these are thin wrappers. The M2 memory ingests the reconciliation rows on its own decay
 * pass ([[storefront-lever-memory]] `applyReconciliationSignal`) — cross-link, no hard dep.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { reconcileLtvProxy } from "@/lib/storefront/ltv-reconciler";
import { pickCampaignGradeBatch } from "@/lib/storefront/campaign-grader";

export const storefrontLtvReconcileCron = inngest.createFunction(
  { id: "storefront-ltv-reconcile-cron", retries: 1, triggers: [{ cron: "0 14 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-workspaces", async () => {
      const { data } = await admin.from("storefront_ltv_metrics").select("workspace_id");
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });
    for (const workspaceId of workspaceIds) {
      await step.run(`trigger-${workspaceId}`, async () => {
        await inngest.send({ name: "storefront/ltv-reconcile", data: { workspace_id: workspaceId } });
      });
    }
    // Control Tower heartbeat on every daily tick (incl. the empty path) — no early return above.
    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("storefront-ltv-reconcile-cron", { ok: true, produced: result });
    });
    return result;
  },
);

export const storefrontLtvReconcile = inngest.createFunction(
  {
    id: "storefront-ltv-reconcile",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "storefront/ltv-reconcile" }],
  },
  async ({ event, step }) => {
    const { workspace_id, lag_days, window_days } = event.data as {
      workspace_id: string;
      lag_days?: number;
      window_days?: number;
    };
    const result = await step.run("reconcile", () =>
      reconcileLtvProxy({ workspaceId: workspace_id, lagDays: lag_days, windowDays: window_days }),
    );
    // M5 — once cohorts reconcile, dispatch the REVISED campaign grade box-side
    // (grading-cascade-to-box-sessions Phase 4, CEO directive 2026-06-30): pick the batch of
    // pending-revised campaigns whose cohort has now reconciled (pickCampaignGradeBatch surfaces
    // both initial+revised candidates; here the reconciler just landed cohort data, so any
    // pending-revised campaign whose cell reconciled becomes gradeable), and enqueue ONE
    // `campaign-grade` `agent_jobs` row carrying the candidates. The box's campaign-grade lane
    // (scripts/builder-worker.ts → runCampaignGradeJob) then reads each campaign + its reconciliation
    // and writes storefront_campaign_grades via applyBoxCampaignGrade (same UNIQUE(experiment_id)
    // upsert + human-override invariant as the deployed gradeCampaign path). Dedup-gated:
    // skip re-enqueueing while a `campaign-grade` job for this workspace is already queued/building.
    // Best-effort + idempotent.
    const revised = await step.run("grade-revised", async () => {
      const admin = createAdminClient();
      const batch = await pickCampaignGradeBatch({ workspaceId: workspace_id, admin });
      if (!batch.length) return { considered: 0, enqueued: 0 };
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("id")
        .eq("workspace_id", workspace_id)
        .eq("kind", "campaign-grade")
        .in("status", ["queued", "queued_resume", "building", "claimed"])
        .limit(1);
      if (inflight && inflight.length) return { considered: batch.length, enqueued: 1 };
      const { error } = await admin.from("agent_jobs").insert({
        workspace_id: workspace_id,
        spec_slug: "campaign-grade",
        kind: "campaign-grade",
        status: "queued",
        created_by: null,
        // box-grading-session-and-account-count-fixes Phase 3 — carry the ACTING DIRECTOR's function
        // slug so the box lane card renders "Max Grading" (Growth director grades storefront
        // campaigns), not the generic 'Campaign Grade' + default mascot. Surfaced by /api/roadmap/box
        // onto LaneRow + resolved to a persona by personaForKind on the box page.
        instructions: JSON.stringify({ candidates: batch, director_function: "growth" }),
      });
      if (error) {
        console.error(`[storefront-ltv-reconcile] campaign-grade enqueue failed ws=${workspace_id}: ${error.message}`);
        return { considered: batch.length, enqueued: 0 };
      }
      return { considered: batch.length, enqueued: 1 };
    });
    console.log(
      `[storefront-ltv-reconcile] ws=${workspace_id} candidates=${result.candidates} ` +
        `reconciled=${result.reconciled.length} recalibrated=${result.recalibrated} ` +
        `weights_version=${result.weights_version} calibrated=${!!result.calibrated_at} ` +
        `escalations=${result.escalations.length} revised_grade_batch=${revised.considered} enqueued=${revised.enqueued}`,
    );
    return { status: "complete", ...result, revised_grade_batch: revised.considered, revised_grade_enqueued: revised.enqueued };
  },
);
