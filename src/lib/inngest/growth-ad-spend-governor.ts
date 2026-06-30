/**
 * growth-ad-spend-governor — the daily cron + per-workspace event handler that drives the
 * [[../libraries/ad-spend-governor]] supervisor pass (growth-ad-spend-rail spec, Phase 3).
 *
 * The cron (`growth-ad-spend-governor-cron`, `0 12 * * *`) finds every workspace with ≥1
 * [[../tables/ad_spend_budgets]] row and fans out one `growth/ad-spend-governor-sweep` event
 * per workspace; the event handler calls [[../libraries/ad-spend-governor]] `runAdSpendGovernorPass`
 * which rolls up two consecutive same-length windows of [[../tables/daily_meta_ad_spend]] vs the
 * effective ceiling and ESCALATES on a trend over via [[../libraries/platform-director]]
 * `escalateDiagnosisToCeo` + a growth-owned [[../tables/director_activity]] row.
 *
 * Self-monitoring: the cron emits its own `growth-ad-spend-governor-cron` heartbeat at the end
 * (registered in `src/lib/control-tower/registry.ts` with owner `growth`) so a dead supervisor
 * shows as a stale cron tile on the Control Tower.
 *
 * NEVER auto-throttles or pauses a campaign — escalation only ([[../operational-rules]] §
 * North star).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { runAdSpendGovernorPass } from "@/lib/ad-spend-governor";

export const growthAdSpendGovernorCron = inngest.createFunction(
  {
    id: "growth-ad-spend-governor-cron",
    name: "Growth — ad-spend governor daily sweep",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 12 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-budgeted-workspaces", async () => {
      const { data } = await admin.from("ad_spend_budgets").select("workspace_id");
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/ad-spend-governor-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("growth-ad-spend-governor-cron", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.workspaces} workspace(s)`,
      });
    });
    return result;
  },
);

export const growthAdSpendGovernorSweep = inngest.createFunction(
  {
    id: "growth-ad-spend-governor-sweep",
    name: "Growth — ad-spend governor per-workspace pass",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/ad-spend-governor-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string; trigger?: "cron" | "manual" };
    const result = await step.run("run-ad-spend-governor-pass", async () => {
      const admin = createAdminClient();
      const r = await runAdSpendGovernorPass(admin, { workspaceId: workspace_id });
      return { observed: r.observed, escalations: r.escalations };
    });
    console.log(
      `[growth-ad-spend-governor] ws=${workspace_id} observed=${result.observed} escalations=${result.escalations}`,
    );
    return { status: "complete", ...result };
  },
);
