/**
 * SMS Marketing Agent scheduling — Inngest functions (the CMO/Iris cadence engine).
 *
 *   sms-marketing-cron — daily fan-out: finds every workspace with an ACTIVE
 *     sms_marketing_policy and fires one schedule event each. Runs at 12:00 UTC —
 *     AFTER refresh-customer-segments (11:00 UTC) so the day's segments are fresh, and
 *     BEFORE the earliest 9am-Eastern send window (13:00 UTC) so morning campaigns have
 *     lead time to stage.
 *   sms-marketing-schedule — per-workspace worker: runs the agent's gate → freshness →
 *     build+schedule loop for one workspace (docs/brain/inngest/sms-marketing.md).
 *
 * Thin wrappers — the logic lives in [[sms-marketing-agent]]. Mirrors the Storefront
 * Optimizer cron pair (src/lib/inngest/storefront-optimizer.ts).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { runSmsMarketingAgent } from "@/lib/sms-marketing-agent";

export const smsMarketingCron = inngest.createFunction(
  { id: "sms-marketing-cron", retries: 1, triggers: [{ cron: "0 12 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-active-policies", async () => {
      const { data } = await admin
        .from("sms_marketing_policy")
        .select("workspace_id")
        .eq("active", true);
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });
    for (const workspaceId of workspaceIds) {
      await step.run(`trigger-${workspaceId}`, async () => {
        await inngest.send({ name: "sms-marketing/schedule", data: { workspace_id: workspaceId } });
      });
    }
    // Heartbeat on EVERY tick (incl. the no-active-policy path) so the freshness monitor sees a
    // daily beat. No early return above.
    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("sms-marketing-cron", { ok: true, produced: result });
    });
    return result;
  },
);

export const smsMarketingSchedule = inngest.createFunction(
  {
    id: "sms-marketing-schedule",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "sms-marketing/schedule" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    const result = await step.run("run-agent", () => runSmsMarketingAgent(workspace_id));
    console.log(
      `[sms-marketing] ws=${workspace_id} status=${result.status} theme=${result.theme ?? "-"} ` +
        `scheduled=${result.campaigns.length} skipped=${result.skippedSegments.length} reason=${result.reason ?? "-"}`,
    );
    return { ...result };
  },
);
