import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  for (const t of ["products","product_pricing_rule","product_variants"]) {
    const { count } = await admin.from(t as any).select("*", { count: "exact", head: true }).eq("workspace_id", WS);
    console.log(t, "rows:", count);
  }
  // protection product + insure01 variants
  const { data: pv } = await admin.from("product_variants").select("id, product_id, sku, shopify_variant_id, price_cents, title").eq("workspace_id", WS).ilike("sku","insure01");
  console.log("insure01 variants:", JSON.stringify(pv, null, 1));
  const pids = [...new Set((pv??[]).map((v:any)=>v.product_id))];
  const { data: pr } = await admin.from("products").select("id,title").in("id", pids as string[]);
  console.log("their products:", JSON.stringify(pr));
  const { data: allp } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  console.log("all product titles:", (allp??[]).map((p:any)=>p.title).join(" | "));
  const { data: assigns } = await admin.from("product_pricing_rule").select("product_id, pricing_rule_id").eq("workspace_id", WS);
  const ruleP = new Set((assigns??[]).filter((a:any)=>a.pricing_rule_id==="ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19").map((a:any)=>a.product_id));
  console.log("assign rows:", assigns?.length, "distinct rules:", new Set((assigns??[]).map((a:any)=>a.pricing_rule_id)).size);
  console.log("products NOT on rule:", (allp??[]).filter((p:any)=>!ruleP.has(p.id)).map((p:any)=>p.title));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
