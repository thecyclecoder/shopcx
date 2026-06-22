/**
 * Storefront predicted-LTV-per-visitor refresh — Inngest worker (Phase 2 of the
 * storefront LTV-proxy reconciler, docs/brain/specs/storefront-ltv-proxy-reconciler.md).
 *
 *   storefront-ltv-metrics-refresh — per-workspace worker: computes
 *     predicted-LTV-per-visitor for every active (product × lander_type × audience)
 *     cohort and upserts [[storefront_ltv_metrics]] (the fast-loop REWARD the M1 bandit
 *     decides on). Idempotent — re-running a snapshot day overwrites.
 *
 * Triggered by [[storefront-experiments]] AFTER its per-workspace attribution rollup
 * completes (`storefront/ltv-metrics-refresh`), so the metric always reads fresh
 * attribution. Thin wrapper; the work lives in [[storefront-ltv-metrics]].
 */
import { inngest } from "@/lib/inngest/client";
import { refreshLtvMetrics } from "@/lib/storefront/ltv-metrics";

export const storefrontLtvMetricsRefresh = inngest.createFunction(
  {
    id: "storefront-ltv-metrics-refresh",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "storefront/ltv-metrics-refresh" }],
  },
  async ({ event, step }) => {
    const { workspace_id, window_days } = event.data as { workspace_id: string; window_days?: number };
    const result = await step.run("refresh", () =>
      refreshLtvMetrics({ workspaceId: workspace_id, windowDays: window_days }),
    );
    console.log(
      `[storefront-ltv-metrics] ws=${workspace_id} snapshot=${result.snapshot_date} ` +
        `cohorts=${result.cohorts} calibrated=${result.calibrated} weights_version=${result.weights_version}`,
    );
    return { status: "complete", ...result };
  },
);
