import { createAdminClient } from "./_bootstrap";
import { computeCover } from "../src/lib/logistics/cover";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").not("shopify_access_token_encrypted","is",null);
  const wsId = ws![0].id;
  const { data: items } = await admin.from("qb_items").select("id, quickbooks_name, sku")
    .eq("workspace_id", wsId).eq("item_type","bundle").or("quickbooks_name.ilike.%strawberry lemonade%,quickbooks_name.ilike.%mixed berry%");
  const tracked = (items ?? []).map(i => ({ bundleQbId: i.id }));
  console.log("tracked bundles:", (items??[]).map(i=>i.quickbooks_name+" / "+i.sku));

  for (const [label, since, until, months] of [
    ["JUNE 2026", "2026-06-01","2026-06-30",1],
    ["TRAILING 3mo (Apr-Jun)", "2026-04-01","2026-06-30",3],
  ] as const) {
    console.log("\n========== " + label + " ==========");
    const rows = await computeCover(admin, wsId, tracked, since, until, months);
    for (const r of rows) {
      console.log(`\n${r.name}`);
      console.log(`  burn/mo: ${r.burnPerMonth.toFixed(0)}  (shop ${r.burnShopify.toFixed(0)} | int ${r.burnInternal.toFixed(0)} | amz ${r.burnAmazon.toFixed(0)})`);
      console.log(`  on-hand sellable: ${r.onHandSellable}  pipeline: ${r.onHandPipeline}`);
      console.log(`  cover sellable: ${r.coverSellableMonths?.toFixed(2)}mo  pipeline: ${r.coverPipelineMonths?.toFixed(2)}mo`);
    }
  }
})();
