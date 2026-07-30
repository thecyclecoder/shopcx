import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_ACCT_UUID="2a97bb87-9806-472f-a4a7-f6f6125dd9bf";
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("media_buyer_test_cohorts").select("*").eq("workspace_id",WS).eq("meta_ad_account_id",TABS_ACCT_UUID);
  console.log("Tabs cohort row(s):", JSON.stringify(data, null, 2));
  // what campaign do the Tabs test adsets live in?
  const testAdset = (data?.[0] as any)?.test_meta_adset_id;
  if (testAdset) {
    const { data: as } = await admin.from("meta_adsets").select("meta_adset_id, meta_campaign_id, name, effective_status").eq("workspace_id",WS).eq("meta_adset_id", testAdset);
    console.log("\ntest_meta_adset_id resolves to:", JSON.stringify(as, null, 2));
  }
  // all Tabs-account campaigns w/ live adsets
  const { data: tabsAdsets } = await admin.from("meta_adsets").select("meta_campaign_id, name, effective_status").eq("workspace_id",WS).eq("meta_ad_account_id",TABS_ACCT_UUID).eq("effective_status","ACTIVE");
  const camps = new Map<string,number>();
  for(const a of (tabsAdsets||[]) as any[]) camps.set(a.meta_campaign_id, (camps.get(a.meta_campaign_id)||0)+1);
  console.log("\nTabs account ACTIVE adsets by campaign:", JSON.stringify([...camps.entries()]));
  // campaign names
  const { data: mc } = await admin.from("meta_campaigns").select("meta_campaign_id, name, effective_status").eq("workspace_id",WS).eq("meta_ad_account_id",TABS_ACCT_UUID);
  console.log("\nTabs account campaigns:", JSON.stringify(mc, null, 2));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
