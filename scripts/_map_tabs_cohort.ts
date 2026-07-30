import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_PRODUCT="221d272d-a6c5-4a5d-86ff-ac693926c992";
const TABS_TEST_CAMPAIGN="120250066504550326";
const COHORT_ID="867ccfe9-5ca0-4a4f-b9b5-1116792a659c";
async function main(){
  const admin=createAdminClient();
  // confirm campaign name
  const { data: mc } = await admin.from("meta_campaigns").select("name, effective_status").eq("workspace_id",WS).eq("meta_campaign_id",TABS_TEST_CAMPAIGN).maybeSingle();
  console.log(`campaign ${TABS_TEST_CAMPAIGN}: "${(mc as any)?.name}" [${(mc as any)?.effective_status}]`);
  // confirm product
  const { data: p } = await admin.from("products").select("title").eq("id",TABS_PRODUCT).maybeSingle();
  console.log(`product ${TABS_PRODUCT}: "${(p as any)?.title}"`);
  // BEFORE
  const { data: before } = await admin.from("media_buyer_test_cohorts").select("product_id, test_meta_campaign_id, adset_per_test, test_meta_adset_id").eq("id",COHORT_ID).maybeSingle();
  console.log("\nBEFORE:", JSON.stringify(before));
  // additive mapping only: product_id + test_meta_campaign_id (leave adset_per_test/test_meta_adset_id for #31)
  const { error } = await admin.from("media_buyer_test_cohorts")
    .update({ product_id: TABS_PRODUCT, test_meta_campaign_id: TABS_TEST_CAMPAIGN, updated_at: new Date().toISOString() })
    .eq("id",COHORT_ID);
  if (error) { console.error("UPDATE failed:", error.message); process.exit(1); }
  const { data: after } = await admin.from("media_buyer_test_cohorts").select("product_id, test_meta_campaign_id, adset_per_test, test_meta_adset_id").eq("id",COHORT_ID).maybeSingle();
  console.log("AFTER: ", JSON.stringify(after));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
