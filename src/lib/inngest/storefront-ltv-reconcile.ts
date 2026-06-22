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
import { gradeRevisedForReconciledCohorts } from "@/lib/storefront/campaign-grader";

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
    // M5 — once cohorts reconcile, land the REVISED campaign grade for any concluded campaign whose
    // cohort now has its actual 4-month LTV (the proxy-time call truth-checked, [[storefront-campaign-grader]]).
    // Best-effort + idempotent (skips already-revised + unreconciled cohorts).
    const revised = await step.run("grade-revised", () => gradeRevisedForReconciledCohorts({ workspaceId: workspace_id }));
    console.log(
      `[storefront-ltv-reconcile] ws=${workspace_id} candidates=${result.candidates} ` +
        `reconciled=${result.reconciled.length} recalibrated=${result.recalibrated} ` +
        `weights_version=${result.weights_version} calibrated=${!!result.calibrated_at} ` +
        `escalations=${result.escalations.length} revised_grades=${revised.revised}`,
    );
    return { status: "complete", ...result, revised_grades: revised.revised };
  },
);
