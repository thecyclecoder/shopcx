// One-time seed of the canonical inventory model from the live feeds (same logic as the
// crons), then reconcile FBA + 3PL vs the Shoptics golden. Read-only from the sources.
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { fetchFbaInventoryByAsin } from "../src/lib/amazon/fba-inventory";
import { fetchAmplifierInventory } from "../src/lib/integrations/amplifier";
import { writeInventory, type InventoryRow } from "../src/lib/inventory/write";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  // FBA
  const { data: conns } = await admin.from("amazon_connections").select("id, marketplace_id").eq("is_active", true);
  const conn = conns![0];
  const { data: asins } = await admin.from("amazon_asins").select("asin, sku, product_id").eq("workspace_id", WS);
  const amap = new Map((asins ?? []).map((a) => [a.asin, a]));
  const fba = await fetchFbaInventoryByAsin(conn.id, conn.marketplace_id);
  const fbaRows: InventoryRow[] = fba.map((f) => ({ external_ref: f.asin, sku: amap.get(f.asin)?.sku ?? f.sellerSku, product_id: amap.get(f.asin)?.product_id ?? null, on_hand: f.onHand, inbound: f.inbound, reserved: f.reserved }));
  await writeInventory(admin, WS, "fba", fbaRows, today);

  // 3PL
  const inv = await fetchAmplifierInventory(WS);
  const tplRows: InventoryRow[] = inv.map((r) => ({ external_ref: r.sku, sku: r.sku, on_hand: r.quantity_available }));
  await writeInventory(admin, WS, "amplifier_3pl", tplRows, today);

  console.log(`Seeded inventory_levels: ${fbaRows.length} FBA (by ASIN) + ${tplRows.length} 3PL (by SKU)\n`);

  // Reconcile a few known cells against the Shoptics golden last-snapshot values
  const readLevel = async (loc: string, ref: string) => {
    const { data } = await admin.from("inventory_levels").select("on_hand").eq("workspace_id", WS).eq("location", loc).eq("external_ref", ref).maybeSingle();
    return data?.on_hand ?? null;
  };
  const checks: [string, string, string, number][] = [
    ["fba", "B0BHLG5DGY", "SL 1-pack FBA", 52],
    ["fba", "B0BJRX45JF", "SL 2-pack FBA", 25],
    ["amplifier_3pl", "FBA-X003F9FU6D", "SL 3PL case", 8],
    ["amplifier_3pl", "FBA-B0BJRX45JF", "SL 3PL case", 10],
  ];
  console.log("Reconcile canonical vs Shoptics golden:");
  for (const [loc, ref, label, golden] of checks) {
    const v = await readLevel(loc, ref);
    console.log(`  ${v === golden ? "✓" : "≈"} ${label.padEnd(16)} ${loc}/${ref}: ${v} (golden ${golden})`);
  }
  const { count } = await admin.from("inventory_levels").select("*", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`\n  inventory_levels now holds ${count} rows for the workspace.`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
