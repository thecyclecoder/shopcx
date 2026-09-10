import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const M = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const ctx = await M.loadPricingContext(WS, RULE);
  // catalog: duplicate SKUs?
  const vars: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("product_variants").select("id, product_id, sku, shopify_variant_id, price_cents, title").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; vars.push(...data); if(data.length<1000)break; }
  const bySku = new Map<string, any[]>();
  for (const v of vars) { const k = String(v.sku ?? "").toLowerCase(); const a = bySku.get(k) ?? []; a.push(v); bySku.set(k, a); }
  console.log("catalog variants:", vars.length);
  for (const [k,a] of bySku) if (a.length>1) console.log("DUP SKU in catalog:", k, a.map(v=>`${v.shopify_variant_id}/${v.price_cents}/${v.title}`).join("  ||  "));
  console.log("--- null sku variants:", vars.filter(v=>!v.sku).length, "null shopify_variant_id:", vars.filter(v=>!v.shopify_variant_id).length);

  const ids = ["27844280493","27847131309","27844575405","27946811565","27898511533","27881013421"];
  for (const id of ids) {
    const { data: s } = await admin.from("appstle_contract_snapshots").select("*").eq("workspace_id", WS).eq("appstle_contract_id", id).maybeSingle();
    if (!s) continue;
    console.log("\n=== contract", id, "status", (s as any).status);
    for (const l of (s as any).lines) console.log("   snapline", JSON.stringify({sku:l.sku, vid:l.variant_id, q:l.quantity, cur:l.current_price_cents, eff:l.effective_unit_cents, title:l.title}));
    const plan = M.planMigration(s as any, ctx);
    for (const l of plan.lines) console.log("   PLAN", JSON.stringify({sku:l.sku, vid:l.shopifyVariantId, remap:l.remappedFrom, q:l.quantity, base:l.baseCents, std:l.standardUnitCents, gf:l.grandfatherUnitCents, fin:l.finalUnitCents, onRule:l.onRule, prot:l.isProtection}));
    console.log("   mixQty", plan.mixQty, "breakPct", plan.breakPct, "dropped", JSON.stringify(plan.dropped));
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
