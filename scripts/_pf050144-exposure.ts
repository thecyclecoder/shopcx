/**
 * Blast radius of the invalid PF050144 tax code.
 * Avalara REJECTS PF050144 and falls back to P0000000 (general tangible goods), so every
 * supplement line has been taxed as general merchandise.
 *
 * line_items is inconsistent — some rows carry product_id, older ones only variant_id — so this
 * resolves BOTH, mapping variant_id → product_variants.product_id. Measured, not estimated.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();

  const { data: prods, error: pe } = await a.from("products").select("id,title,avalara_tax_code").eq("workspace_id", WS);
  if (pe) throw new Error(`products: ${pe.message}`);
  const badIds = new Set((prods ?? []).filter((p) => String(p.avalara_tax_code) === "PF050144").map((p) => String(p.id)));
  console.log(`products carrying the invalid PF050144 code: ${badIds.size}`);

  // variant_id → product_id, so old line_items rows resolve too.
  const { data: variants, error: ve } = await a.from("product_variants").select("id,product_id");
  if (ve) throw new Error(`product_variants: ${ve.message}`);
  const variantToProduct = new Map((variants ?? []).map((v) => [String(v.id), String(v.product_id)]));
  console.log(`variant→product map: ${variantToProduct.size} variants`);

  const { data: orders, error: oe } = await a.from("orders")
    .select("order_number,created_at,avalara_total_tax_cents,line_items,shipping_address")
    .eq("workspace_id", WS).gt("avalara_total_tax_cents", 0).order("created_at", { ascending: true });
  if (oe) throw new Error(`orders: ${oe.message}`);

  let affected = 0, taxOnAffected = 0, unresolved = 0;
  const byState = new Map<string, { n: number; cents: number }>();
  let first = "", last = "";
  for (const o of orders ?? []) {
    const lines = (o.line_items ?? []) as Array<Record<string, unknown>>;
    let hit = false;
    for (const l of lines) {
      const pid = l.product_id ? String(l.product_id) : variantToProduct.get(String(l.variant_id ?? ""));
      if (!pid) { unresolved += 1; continue; }
      if (badIds.has(pid)) hit = true;
    }
    if (!hit) continue;
    affected += 1;
    taxOnAffected += Number(o.avalara_total_tax_cents);
    const st = String((o.shipping_address as Record<string, unknown>)?.provinceCode ?? "?");
    const e = byState.get(st) ?? { n: 0, cents: 0 };
    e.n += 1; e.cents += Number(o.avalara_total_tax_cents);
    byState.set(st, e);
    if (!first) first = String(o.created_at).slice(0, 10);
    last = String(o.created_at).slice(0, 10);
  }

  console.log(`\norders with Avalara tax containing a PF050144 product: ${affected} of ${(orders ?? []).length}`);
  console.log(`total tax charged on those orders: $${(taxOnAffected / 100).toFixed(2)}   (window ${first} → ${last})`);
  if (unresolved) console.log(`(${unresolved} line(s) could not be resolved to a product — excluded)`);
  console.log(`\n⚠️  That is tax CHARGED, not tax OVERCHARGED. The overcharge depends on which VALID code`);
  console.log(`    is correct for these products — a tax-compliance decision, not one to pick by outcome.`);
  console.log(`\nstate   orders   tax charged`);
  for (const [st, e] of [...byState.entries()].sort((x, y) => y[1].cents - x[1].cents).slice(0, 12)) {
    console.log(`  ${st.padEnd(5)} ${String(e.n).padStart(5)}    $${(e.cents / 100).toFixed(2)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
