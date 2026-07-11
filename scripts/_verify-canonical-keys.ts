import { createAdminClient } from "./_bootstrap";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").not("shopify_access_token_encrypted","is",null);
  const wsId = ws![0].id;
  // canonical shopify inventory
  const { data: lv } = await admin.from("inventory_levels").select("external_ref, variant_id, on_hand").eq("workspace_id", wsId).eq("location","shopify");
  const byVar = new Map((lv??[]).map(l=>[String(l.variant_id ?? l.external_ref), l.on_hand]));
  console.log(`inventory_levels(shopify): ${lv?.length} rows`);
  // product_variants
  const { data: pv } = await admin.from("product_variants").select("shopify_variant_id, sku, title, inventory_quantity, available").eq("workspace_id", wsId);
  console.log(`product_variants: ${pv?.length} rows`);
  // match rate: how many product_variants have a canonical on_hand by shopify_variant_id?
  let matched=0, missing=0; const samples:string[]=[];
  for (const v of pv ?? []) {
    const key = String(v.shopify_variant_id);
    if (byVar.has(key)) { matched++; if (samples.length<6) samples.push(`sku=${v.sku} vid=${key} storeB=${v.inventory_quantity} canonical=${byVar.get(key)}`); }
    else missing++;
  }
  console.log(`matched by shopify_variant_id: ${matched}, missing: ${missing}`);
  console.log("samples (storeB stale vs canonical fresh):"); samples.forEach(s=>console.log("  "+s));
  // Specifically the crisis SKUs
  for (const [name, sku] of [["MB-30","SC-TABS-BERRY"],["SL-30","SC-TABS-SL-2"]] as const) {
    const v = (pv??[]).find(x=>x.sku===sku);
    if (v) console.log(`\n${name} (${sku}): storeB=${v.inventory_quantity} canonical=${byVar.get(String(v.shopify_variant_id))} vid=${v.shopify_variant_id}`);
  }
})();
