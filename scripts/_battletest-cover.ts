import { createAdminClient } from "./_bootstrap";
import { computeCover } from "../src/lib/logistics/cover";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").not("shopify_access_token_encrypted","is",null);
  const wsId = ws![0].id;
  const { data: items } = await admin.from("qb_items").select("id, quickbooks_name, sku")
    .eq("workspace_id", wsId).eq("item_type","bundle").or("quickbooks_name.ilike.%strawberry lemonade - 30%,quickbooks_name.ilike.%mixed berry - 30%,quickbooks_name.ilike.%mixed berry - 10%");
  const tracked = (items ?? []).map(i => ({ bundleQbId: i.id }));
  const until = new Date().toISOString().slice(0,10);
  const since = new Date(Date.now()-90*86400000).toISOString().slice(0,10);
  console.log(`window ${since} -> ${until} (3mo)\n`);
  const rows = await computeCover(admin, wsId, tracked, since, until, 3);
  for (const r of rows) {
    console.log(`${r.name}`);
    console.log(`  STOREFRONT (3PL): burn ${r.burnStorefront.toFixed(0)}/mo  on-hand ${r.onHandStorefront}  cover ${r.coverStorefrontMonths==null?"n/a":r.coverStorefrontMonths.toFixed(2)+"mo"}`);
    console.log(`  AMAZON (FBA):     burn ${r.burnAmazon.toFixed(0)}/mo  on-hand ${r.onHandAmazon} (pipe ${r.onHandAmazonPipeline})  cover ${r.coverAmazonMonths==null?"n/a":r.coverAmazonMonths.toFixed(2)+"mo"} (pipe ${r.coverAmazonPipelineMonths==null?"n/a":r.coverAmazonPipelineMonths.toFixed(2)+"mo"})`);
    console.log(`  total burn ${r.burnPerMonth.toFixed(0)}/mo (shop ${r.burnShopify.toFixed(0)} int ${r.burnInternal.toFixed(0)} amz ${r.burnAmazon.toFixed(0)})\n`);
  }
})();
