import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS="221d272d-a6c5-4a5d-86ff-ac693926c992";
(async()=>{
  const admin=createAdminClient();
  const {data,error}=await admin.from("media_buyer_test_cohorts").select("*").eq("workspace_id",WS);
  if(error){console.log("ERR:",error.message);return;}
  console.log(`ALL COHORTS (${data?.length}):`);
  for(const c of (data||[]) as any[]){
    const isTabs = c.product_id===TABS;
    console.log(`${isTabs?"➤ TABS ":"  "}product=${(c.product_id||"null").slice(0,8)} acct=${c.meta_ad_account_id} camp=${c.test_meta_campaign_id} adset=${c.test_meta_adset_id} active=${c.is_active}`);
    if(isTabs) console.log("   FULL:", JSON.stringify(c));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
