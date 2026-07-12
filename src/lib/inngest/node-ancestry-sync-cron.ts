/**
 * node-ancestry-sync-cron — nightly backstop for the kill-switch cascade mirror.
 *
 * `public.node_ancestry` is a DB mirror of the canonical node registry (which lives in code —
 * `src/lib/control-tower/node-registry.ts`). The box worker syncs it on startup, so a deploy is
 * always in sync. This cron is the nightly BACKSTOP for the edge case where the box hasn't
 * restarted (long-uptime deploy chain) but the registry has drifted from an in-place SDK bump.
 *
 * Fail-open by design — a sync error just means `public.claim_agent_job` sees an out-of-date
 * mirror; the RPC still claims (an unregistered kind falls through to the fail-open path). This
 * cron emits a heartbeat so the Control Tower monitor can flag a persistent sync failure.
 *
 * See [[../../../docs/brain/inngest/node-ancestry-sync-cron]].
 */
import { inngest } from "@/lib/inngest/client";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { syncNodeAncestry } from "@/lib/control-tower/node-ancestry-sync";

export const nodeAncestrySyncCron = inngest.createFunction(
  {
    id: "node-ancestry-sync-cron",
    name: "node_ancestry — nightly registry mirror sync",
    retries: 1,
    concurrency: [{ limit: 1 }],
    // 03:15 UTC nightly — off-hours; a failure here is not a live outage (the claim RPC is
    // fail-open) so we don't need to fire more often.
    triggers: [{ cron: "15 3 * * *" }],
  },
  async ({ step }) => {
    const startedAt = Date.now();
    const result = await step.run("sync-node-ancestry", async () => syncNodeAncestry());

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("node-ancestry-sync-cron", {
        ok: result.ok,
        produced: { upserted: result.upserted, deleted: result.deleted },
        detail: result.detail,
        durationMs: Date.now() - startedAt,
      });
    });

    return result;
  },
);
