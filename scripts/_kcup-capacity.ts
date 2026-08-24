/**
 * Coffee K-Cups have stock (CEO). How much, where, and can they carry ad spend
 * while the rest of FBA is empty and whole-bean Coffee is out?
 */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUP_RE = /KCUP|K-CUP|POD|COFFEEPOD|NP24/i;

async function main() {
  const admin = createAdminClient();

  // ── stock ──
  const inv: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("inventory_levels")
      .select("location,sku,on_hand,inbound,reserved,product_id,source_synced_at")
      .eq("workspace_id", WS).range(off, off + 999);
    if (error) throw new Error(error.message);
    inv.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log("=== K-CUP / POD SKUs IN STOCK ===");
  console.log("location        sku                              onHand  inbound  reserved");
  let tplUnits = 0, fbaUnits = 0;
  for (const r of inv.filter((r) => KCUP_RE.test(String(r.sku)) && !/DMG|DAMAG|TEST/i.test(String(r.sku)))
    .sort((a, b) => Number(b.on_hand ?? 0) - Number(a.on_hand ?? 0))) {
    const q = Number(r.on_hand ?? 0);
    if (r.location === "amplifier_3pl") tplUnits += q;
    if (r.location === "fba") fbaUnits += q - Number(r.reserved ?? 0);
    console.log(`${String(r.location).padEnd(15)} ${String(r.sku).slice(0, 30).padEnd(32)} ${String(q).padStart(6)} ${String(r.inbound).padStart(8)} ${String(r.reserved).padStart(9)}`);
  }
  console.log(`\n  3PL (website) K-Cup units: ${tplUnits.toLocaleString()}`);
  console.log(`  FBA (Amazon)  K-Cup units: ${fbaUnits.toLocaleString()}`);

  // ── how does the SKU actually perform as an acquisition product? ──
  const { data: ws } = await admin.from("workspaces").select("order_source_mapping").eq("id", WS).single();
  const sm = (ws?.order_source_mapping ?? {}) as Record<string, string>;
  const orders: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("orders")
      .select("id,total_cents,source_name,tags,subscription_id,line_items")
      .eq("workspace_id", WS)
      .gte("created_at", "2026-05-01T05:00:00Z").lt("created_at", "2026-08-01T05:00:00Z")
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    orders.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const byProduct: Record<string, { orders: Set<string>; units: number; rev: number; subs: number }> = {};
  for (const o of orders) {
    const b = bucketOrder(o as never, sm);
    if (b !== "new_sub" && b !== "one_time") continue;
    for (const li of (Array.isArray(o.line_items) ? o.line_items : []) as Array<Record<string, unknown>>) {
      const t = String(li.title ?? li.name ?? "");
      if (!t) continue;
      byProduct[t] ??= { orders: new Set(), units: 0, rev: 0, subs: 0 };
      byProduct[t].orders.add(String(o.id));
      byProduct[t].units += Number(li.quantity ?? 1);
      byProduct[t].rev += Number(li.price_cents ?? 0) * Number(li.quantity ?? 1);
      if (b === "new_sub") byProduct[t].subs++;
    }
  }

  console.log("\n=== WEBSITE ACQUISITION BY PRODUCT (May–Jul), sub rate + AOV ===");
  console.log("product                        orders  units   revenue    AOV   sub-rate");
  for (const [p, v] of Object.entries(byProduct)
    .filter(([, v]) => v.orders.size >= 20)
    .sort((a, b) => b[1].orders.size - a[1].orders.size)) {
    const n = v.orders.size;
    console.log(
      `${p.slice(0, 28).padEnd(30)} ${String(n).padStart(6)} ${String(v.units).padStart(6)}  $${(v.rev / 100).toFixed(0).padStart(7)}  $${(v.rev / 100 / n).toFixed(0).padStart(4)}   ${((v.subs / n) * 100).toFixed(0)}%`
    );
  }

  console.log("\n=== CAN K-CUPS CARRY THE PHASE 1 STEP? ===");
  const kc = byProduct["Amazing Coffee K-Cups"];
  if (kc) {
    const n = kc.orders.size;
    const aov = kc.rev / 100 / n;
    console.log(`  K-Cups website acquisition May–Jul: ${n} orders over 3 months (~${(n / 3).toFixed(0)}/mo) at $${aov.toFixed(0)} AOV`);
    console.log(`  3PL units on hand: ${tplUnits.toLocaleString()} → ~${Math.floor(tplUnits / Math.max(kc.units / n, 1)).toLocaleString()} orders of headroom at ${(kc.units / n).toFixed(1)} units/order`);
    console.log(`  Phase 1 needs ~+102 customers/mo. K-Cups alone could cover that on stock;`);
    console.log(`  the open question is DEMAND, not supply — it ran ~${(n / 3).toFixed(0)}/mo while barely advertised.`);
  } else {
    console.log("  no K-Cup acquisition orders found in the window");
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
