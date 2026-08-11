/**
 * Ship-time backfill: draw down the VitaQuest raw-carton manual-inventory row by the 9,652 IFC
 * cartons consumed producing the Mixed Berry finished goods received on QB Bill #117599
 * (VitaQuest, 2026-07-30). 10,725 → 1,073.
 *
 * The cartons were booked as on-hand at VitaQuest and never drawn down when they became
 * finished goods, so the July audit counted them twice — once as raw IFC, once inside the
 * finished units — showing a phantom +9,571 gain. Mirrors the same correction already applied
 * in the Shoptics DB. Idempotent: only fires on a row still holding the pre-drawdown quantity.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CONSUMED = 9652;
const BEFORE = 10725;

async function main() {
  const admin = createAdminClient();
  const { data: item } = await admin
    .from("qb_items").select("id, quickbooks_name").eq("workspace_id", WS).eq("sku", "SC-TABS-BERRY-C").maybeSingle();
  if (!item) throw new Error("qb_items row for SC-TABS-BERRY-C not found");

  const { data: rows, error } = await admin
    .from("qb_manual_inventory").select("*").eq("workspace_id", WS).eq("product_id", item.id);
  if (error) throw new Error(error.message);
  console.log(`manual rows for ${item.quickbooks_name}:`);
  for (const r of rows ?? []) console.log(`  id=${r.id} qty=${r.quantity} active=${r.active} location=${r.location}`);

  const target = (rows ?? []).find((r) => r.active && Number(r.quantity) === BEFORE);
  if (!target) {
    console.log(`\nno active row at ${BEFORE} — already applied or unexpected state; nothing changed`);
    return;
  }
  const { error: upErr } = await admin
    .from("qb_manual_inventory")
    .update({
      quantity: BEFORE - CONSUMED,
      note: `${target.note ?? ""} | drawn down ${CONSUMED}: consumed into finished goods received via QB Bill #117599 (VitaQuest, 2026-07-30)`.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.id);
  if (upErr) throw new Error(upErr.message);

  const { data: after } = await admin
    .from("qb_manual_inventory").select("quantity, active").eq("workspace_id", WS).eq("product_id", item.id);
  const total = (after ?? []).filter((r) => r.active).reduce((a, r) => a + Number(r.quantity ?? 0), 0);
  console.log(`\n✓ ${BEFORE} -> ${BEFORE - CONSUMED} · active manual total now ${total}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
