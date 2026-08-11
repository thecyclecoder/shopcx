/**
 * Daily sync of the month-end close's `qb_*` source tables from ShopCX's own integrations
 * ([[../qb-close/sync-sources]]). Without this the close can only run on hand-ported Shoptics
 * data — the backfill is one-time.
 *
 * Runs at 09:30, after the FBA (09:00) and 3PL (09:00) logistics syncs, so the upstream APIs
 * have already been exercised for the day.
 *
 * **A DATED SNAPSHOT CANNOT BE RECONSTRUCTED LATER.** Inventory APIs report *now*, so a missed
 * day is a permanently missing period-end physical count — and the close needs the snapshot to
 * land on the actual last day of the month. That is why this is a daily cron rather than
 * something run at close time, and why a failure here is worth alerting on.
 *
 * Sales are re-synced for a trailing window rather than yesterday-only: refunds and edits land
 * days after the sale, and every sales sync is an idempotent upsert on its natural key.
 *
 * Read-only against upstream; never writes QuickBooks. See
 * docs/brain/libraries/qb-close-sync-sources.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  syncShopifySalesForClose,
  syncInternalSalesForClose,
  syncFbaInventoryForClose,
  syncTplInventoryForClose,
  type SyncResult,
} from "@/lib/qb-close/sync-sources";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/** Re-sync this many trailing days of sales so late refunds/edits are picked up. */
const SALES_LOOKBACK_DAYS = 35;

export const syncQbCloseSources = inngest.createFunction(
  {
    id: "sync-qb-close-sources",
    retries: 2,
    triggers: [{ cron: "30 9 * * *" }, { event: "cfo/sync-qb-close-sources" }],
  },
  async ({ step, event }) => {
    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - SALES_LOOKBACK_DAYS);
    // The manual event may narrow/widen the window; a cron firing carries neither.
    const override = (event?.data ?? {}) as { start?: string; end?: string };
    const start = override.start ?? from.toISOString().slice(0, 10);
    const end = override.end ?? today;

    // Workspaces that actually run a close — i.e. have the mapping layer ported.
    const workspaces = await step.run("close-workspaces", async () => {
      const { data } = await admin.from("qb_items").select("workspace_id").limit(1000);
      return [...new Set((data ?? []).map((r) => r.workspace_id as string))];
    });

    const results: (SyncResult & { workspace_id: string })[] = [];
    const failures: { workspace_id: string; sync: string; error: string }[] = [];

    for (const ws of workspaces) {
      // Each sync is isolated: an Amplifier outage must not cost us the day's FBA snapshot,
      // which is equally unreconstructible.
      for (const [name, run] of [
        ["shopify-sales", () => syncShopifySalesForClose(admin, ws, start, end)],
        ["internal-sales", () => syncInternalSalesForClose(admin, ws, start, end)],
        ["fba-inventory", () => syncFbaInventoryForClose(admin, ws, today)],
        ["tpl-inventory", () => syncTplInventoryForClose(admin, ws, today)],
      ] as const) {
        const outcome = await step.run(`${name}-${ws}`, async () => {
          try {
            return { ok: true as const, result: await run() };
          } catch (e) {
            return { ok: false as const, error: (e as Error).message.slice(0, 300) };
          }
        });
        if (outcome.ok) results.push({ ...outcome.result, workspace_id: ws });
        else failures.push({ workspace_id: ws, sync: name, error: outcome.error });
      }
    }

    await step.run("heartbeat", async () =>
      emitCronHeartbeat("sync-qb-close-sources", {
        ok: failures.length === 0,
        produced: {
          workspaces: workspaces.length,
          rows: results.reduce((a, r) => a + r.rows, 0),
          failures: failures.length,
        },
      }),
    );

    return { window: { start, end }, snapshot_date: today, results, failures };
  },
);
