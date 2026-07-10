import type { SupabaseClient } from "@supabase/supabase-js";

// Shared writer for the canonical inventory model. Every source (fba / amplifier_3pl /
// shopify / manual) funnels its raw on-hand through here so inventory_levels (current)
// and inventory_snapshots (dated history) stay in lockstep. Upserts are keyed on
// (workspace, location, external_ref) — a source only ever owns its own location rows.

export type InventoryLocation = "shopify" | "fba" | "amplifier_3pl" | "manual";

export interface InventoryRow {
  external_ref: string;
  sku?: string | null;
  product_id?: string | null;
  variant_id?: string | null;
  on_hand: number;
  inbound?: number;
  reserved?: number | null;
}

/** Upsert a source's rows into inventory_levels + today's inventory_snapshots. `snapshotDate`
 *  is YYYY-MM-DD (caller passes it so the whole sync shares one date). */
export async function writeInventory(
  admin: SupabaseClient,
  workspaceId: string,
  location: InventoryLocation,
  rows: InventoryRow[],
  snapshotDate: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const levels = rows.map((r) => ({
    workspace_id: workspaceId, location, external_ref: r.external_ref,
    sku: r.sku ?? null, product_id: r.product_id ?? null, variant_id: r.variant_id ?? null,
    on_hand: r.on_hand, inbound: r.inbound ?? 0, reserved: r.reserved ?? null,
    source_synced_at: now, updated_at: now,
  }));
  const { error: le } = await admin.from("inventory_levels").upsert(levels, { onConflict: "workspace_id,location,external_ref" });
  if (le) throw new Error(`inventory_levels upsert failed: ${le.message}`);

  const snaps = rows.map((r) => ({
    workspace_id: workspaceId, location, external_ref: r.external_ref,
    sku: r.sku ?? null, product_id: r.product_id ?? null,
    on_hand: r.on_hand, inbound: r.inbound ?? 0, snapshot_date: snapshotDate,
  }));
  const { error: se } = await admin.from("inventory_snapshots").upsert(snaps, { onConflict: "workspace_id,location,external_ref,snapshot_date" });
  if (se) throw new Error(`inventory_snapshots upsert failed: ${se.message}`);
  return rows.length;
}
