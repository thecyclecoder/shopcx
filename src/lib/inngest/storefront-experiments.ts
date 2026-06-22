/**
 * Storefront experiment + bandit refresh — Inngest functions (Phase 4/5 of the
 * storefront experiment + bandit framework
 * docs/brain/specs/storefront-experiment-bandit-framework.md).
 *
 *   storefront-experiments-refresh-cron — daily fan-out: finds every workspace with
 *     a running/promoted experiment and fires one refresh event each.
 *   storefront-experiments-refresh — per-workspace worker: recomputes attribution,
 *     runs the rollback guardrail + bandit decision, writes the run record
 *     ([[storefront_experiment_runs]]). Also the manual-trigger entry point.
 *
 * Mirrors the ads-side meta-performance cadence. The heavy lifting lives in
 * [[storefront-experiment-refresh]]; these are thin Inngest wrappers.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshStorefrontExperiments } from "@/lib/storefront/experiment-refresh";

export const storefrontExperimentsRefreshCron = inngest.createFunction(
  { id: "storefront-experiments-refresh-cron", retries: 1, triggers: [{ cron: "0 12 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-active-workspaces", async () => {
      const { data } = await admin
        .from("storefront_experiments")
        .select("workspace_id")
        .in("status", ["running", "promoted"]);
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });
    for (const workspaceId of workspaceIds) {
      await step.run(`trigger-${workspaceId}`, async () => {
        await inngest.send({
          name: "storefront/experiments-refresh",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }
    return { workspaces: workspaceIds.length };
  },
);

export const storefrontExperimentsRefresh = inngest.createFunction(
  {
    id: "storefront-experiments-refresh",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "storefront/experiments-refresh" }],
  },
  async ({ event, step }) => {
    const { workspace_id, trigger, window_days } = event.data as {
      workspace_id: string;
      trigger?: "cron" | "manual";
      window_days?: number;
    };
    const result = await step.run("refresh", () =>
      refreshStorefrontExperiments({
        workspaceId: workspace_id,
        trigger: trigger === "manual" ? "manual" : "cron",
        windowDays: window_days,
      }),
    );
    console.log(
      `[storefront-experiments] ws=${workspace_id} evaluated=${result.experiments_evaluated} ` +
        `promoted=${result.counts.promoted} killed=${result.counts.killed} rolled_back=${result.counts.rolled_back} ` +
        `conservative=${result.conservative}`,
    );
    return { status: "complete", ...result };
  },
);
