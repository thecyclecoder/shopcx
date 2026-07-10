/**
 * Daily 3PL inventory sync — Amplifier /reports/inventory/current → canonical
 * inventory_levels (location='amplifier_3pl') + a dated inventory_snapshots row, keyed by
 * the 3PL SKU. Raw per-SKU on-hand; the finished-good rollup with case-pack multipliers
 * happens in the read layer (qb_sku_mappings). Read-only from Amplifier; never writes
 * QuickBooks. See docs/brain/functions/logistics.md § single source of truth.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAmplifierInventory } from "@/lib/integrations/amplifier";
import { writeInventory, type InventoryRow } from "@/lib/inventory/write";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const sync3plInventory = inngest.createFunction(
  { id: "sync-3pl-inventory", retries: 1, triggers: [{ cron: "0 9 * * *" }, { event: "logistics/sync-3pl-inventory" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);
    const workspaces = await step.run("amplifier-workspaces", async () => {
      const { data } = await admin.from("workspaces").select("id").not("amplifier_api_key_encrypted", "is", null);
      return data ?? [];
    });

    let totalRows = 0;
    for (const ws of workspaces) {
      const written = await step.run(`3pl-${ws.id}`, async () => {
        const inv = await fetchAmplifierInventory(ws.id);
        const rows: InventoryRow[] = inv.map((r) => ({ external_ref: r.sku, sku: r.sku, on_hand: r.quantity_available }));
        return writeInventory(admin, ws.id, "amplifier_3pl", rows, today);
      });
      totalRows += written;
    }

    await step.run("heartbeat", async () => emitCronHeartbeat("sync-3pl-inventory", { ok: true, produced: { workspaces: workspaces.length, rows: totalRows } }));
    return { workspaces: workspaces.length, rows: totalRows };
  },
);
