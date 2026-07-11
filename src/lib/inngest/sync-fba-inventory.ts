/**
 * Daily FBA inventory sync — SP-API getInventorySummaries → canonical inventory_levels
 * (location='fba') + a dated inventory_snapshots row. Read-only from Amazon; writes only
 * our own tables (never QuickBooks). Reuses the existing amazon_connections auth. See
 * docs/brain/functions/logistics.md § single source of truth.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchFbaInventoryByAsin } from "@/lib/amazon/fba-inventory";
import { writeInventory, type InventoryRow } from "@/lib/inventory/write";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const syncFbaInventory = inngest.createFunction(
  { id: "sync-fba-inventory", retries: 1, triggers: [{ cron: "0 9 * * *" }, { event: "logistics/sync-fba-inventory" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);
    const connections = await step.run("active-connections", async () => {
      const { data } = await admin.from("amazon_connections").select("id, workspace_id, marketplace_id").eq("is_active", true);
      return data ?? [];
    });

    let totalRows = 0;
    for (const conn of connections) {
      const written = await step.run(`fba-${conn.id}`, async () => {
        // asin → { product_id, sku } for this workspace
        const { data: asins } = await admin.from("amazon_asins").select("asin, sku, product_id").eq("workspace_id", conn.workspace_id);
        const map = new Map((asins ?? []).map((a) => [a.asin, { product_id: a.product_id as string | null, sku: a.sku as string | null }]));

        const fba = await fetchFbaInventoryByAsin(conn.id, conn.marketplace_id);
        const rows: InventoryRow[] = fba.map((f) => {
          const m = map.get(f.asin);
          return { external_ref: f.asin, sku: m?.sku ?? f.sellerSku, product_id: m?.product_id ?? null, on_hand: f.onHand, inbound: f.inbound, reserved: f.reserved };
        });
        return writeInventory(admin, conn.workspace_id, "fba", rows, today);
      });
      totalRows += written;
    }

    await step.run("heartbeat", async () => emitCronHeartbeat("sync-fba-inventory", { ok: true, produced: { connections: connections.length, rows: totalRows } }));
    return { connections: connections.length, rows: totalRows };
  },
);
