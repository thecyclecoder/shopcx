/**
 * Monthly situation-refresh cron (customer-situations-all-products Phase 2).
 *
 * New reviews arrive daily through the in-house review journey, so a product's best customer
 * situations drift over time. Once a month this cron re-enqueues a `situation-mine` box job for every
 * `is_advertised` product in every workspace that has advertised products, so new reviews feed new
 * situations. Vercel decides WHAT to refresh; the box (runSituationMineJob) does the read + the
 * deterministic applySituationMine write.
 *
 * Idempotent: enqueueSituationMineForAdvertised skips a product with a queued/running job or one
 * mined in the last 7 days — a cron retry (retries:1) can't double the spend, and the ship-time
 * backfill landing days before the first monthly firing is honored (those products are still fresh).
 *
 * Control-tower: registered in MONITORED_LOOPS as `situation-mine-refresh-cron` with a 37d liveness
 * window (monthly cadence ⇒ 37d per the MONITOR_TICK_FLOOR_MS invariant), owner `cmo`. End-of-run
 * heartbeat via emitCronHeartbeat. See docs/brain/libraries/situation-miner.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  enqueueSituationMineForAdvertised,
  workspacesWithAdvertisedProducts,
} from "@/lib/situation-miner";

export const situationMineRefreshCron = inngest.createFunction(
  // Monthly on the 12th at 06:00 — spaced from the other monthly crons (16th / 20th).
  { id: "situation-mine-refresh-cron", retries: 1, triggers: [{ cron: "0 6 12 * *" }] },
  async ({ step }) => {
    const result = await step.run("enqueue-advertised-situation-mines", async () => {
      const admin = createAdminClient();
      const workspaceIds = await workspacesWithAdvertisedProducts(admin);
      let products = 0;
      let enqueued = 0;
      let skippedInflight = 0;
      let skippedFresh = 0;
      for (const workspaceId of workspaceIds) {
        const sweep = await enqueueSituationMineForAdvertised(admin, workspaceId);
        products += sweep.products;
        enqueued += sweep.enqueued;
        skippedInflight += sweep.skippedInflight;
        skippedFresh += sweep.skippedFresh;
      }
      return { workspaces: workspaceIds.length, products, enqueued, skippedInflight, skippedFresh };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("situation-mine-refresh-cron", { ok: true, produced: result });
    });
    return result;
  },
);
