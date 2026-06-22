/**
 * Storefront Optimizer scheduling — Inngest functions (Phase 1 trigger of the
 * storefront-optimizer agent, docs/brain/specs/storefront-optimizer-agent.md).
 *
 *   storefront-optimizer-cron — daily fan-out: finds every workspace with an ACTIVE
 *     optimizer policy and fires one schedule event each. Offset after the M1 refresh
 *     (12:00) + M2 decay (13:00) so the day's learnings + decayed posteriors are
 *     committed before it picks the next lever to test.
 *   storefront-optimizer-schedule — per-workspace worker: enqueues one
 *     `storefront-optimizer` [[agent_jobs]] campaign cycle per DUE
 *     (product × lander-type × audience), deduped to ≤1 active campaign per surface.
 *
 * The box worker (`runStorefrontOptimizerJob`) claims the queued jobs on its own lane,
 * runs the read→hypothesis→variant→stand-up loop, and stands up the M1 experiment. The
 * heavy lifting lives in [[storefront-optimizer-agent]]; these are thin wrappers.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enqueueDueCampaigns } from "@/lib/storefront/optimizer-agent";

export const storefrontOptimizerCron = inngest.createFunction(
  { id: "storefront-optimizer-cron", retries: 1, triggers: [{ cron: "30 14 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-active-policies", async () => {
      const { data } = await admin
        .from("storefront_optimizer_policy")
        .select("workspace_id")
        .eq("active", true);
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });
    for (const workspaceId of workspaceIds) {
      await step.run(`trigger-${workspaceId}`, async () => {
        await inngest.send({ name: "storefront/optimizer-schedule", data: { workspace_id: workspaceId } });
      });
    }
    // Control Tower heartbeat on EVERY tick (incl. the no-active-policy path) so the
    // freshness monitor sees a daily beat. No early return above.
    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("storefront-optimizer-cron", { ok: true, produced: result });
    });
    return result;
  },
);

export const storefrontOptimizerSchedule = inngest.createFunction(
  {
    id: "storefront-optimizer-schedule",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "storefront/optimizer-schedule" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    const result = await step.run("enqueue-due-campaigns", () => enqueueDueCampaigns({ workspaceId: workspace_id }));
    console.log(
      `[storefront-optimizer] ws=${workspace_id} active=${result.active} considered=${result.considered} enqueued=${result.enqueued}`,
    );
    return { status: "complete", ...result };
  },
);
