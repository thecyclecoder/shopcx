/**
 * Storefront lever-importance decay — Inngest functions (Phase 3/4 of the lever-
 * importance memory, docs/brain/specs/storefront-lever-importance-memory.md).
 *
 *   storefront-lever-decay-cron — daily fan-out: finds every workspace with lever
 *     posteriors and fires one decay event each. Mirrors the M1 refresh cadence
 *     ([[storefront-experiments]]), offset +1h so it lands after the attribution
 *     refresh has committed the day's learnings.
 *   storefront-lever-decay — per-workspace worker: decays each posterior toward its
 *     prior as `last_tested_at` ages (the re-probe clock), then ingests the M3
 *     reconciler's recalibration signal if present.
 *
 * The heavy lifting lives in [[storefront-lever-memory]]; these are thin wrappers.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { decayLeverImportance, applyReconciliationSignal } from "@/lib/storefront/lever-memory";

export const storefrontLeverDecayCron = inngest.createFunction(
  { id: "storefront-lever-decay-cron", retries: 1, triggers: [{ cron: "0 13 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-workspaces", async () => {
      const { data } = await admin.from("storefront_lever_importance").select("workspace_id");
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });
    for (const workspaceId of workspaceIds) {
      await step.run(`trigger-${workspaceId}`, async () => {
        await inngest.send({ name: "storefront/lever-decay", data: { workspace_id: workspaceId } });
      });
    }
    // Control Tower heartbeat on every daily tick (incl. the empty path) — no early return above.
    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("storefront-lever-decay-cron", { ok: true, produced: result });
    });
    return result;
  },
);

export const storefrontLeverDecay = inngest.createFunction(
  {
    id: "storefront-lever-decay",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "storefront/lever-decay" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    const decay = await step.run("decay", () => decayLeverImportance({ workspaceId: workspace_id }));
    const m3 = await step.run("m3-reconciler-intake", () => applyReconciliationSignal({ workspaceId: workspace_id }));
    console.log(
      `[storefront-lever-decay] ws=${workspace_id} decayed=${decay.decayed} ` +
        `m3_signal_present=${m3.present} m3_applied=${m3.applied}`,
    );
    return { status: "complete", decayed: decay.decayed, m3 };
  },
);
