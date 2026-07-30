import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { hasFreshMetaSignal } from "../src/lib/media-buyer/meta-cpa-signal";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // active cohorts: which meta accounts does Bianca iterate?
  const {data:cohorts}=await admin.from("media_buyer_test_cohorts").select("product_id,default_meta_account_id,meta_ad_account_id,is_active,test_meta_campaign_id").eq("workspace_id",WS).eq("is_active",true);
  console.log("ACTIVE cohorts (Bianca's coverage):");
  const covered=new Set<string>();
  for(const c of (cohorts||[]) as any[]){ covered.add(String(c.default_meta_account_id)); console.log(`  acct=${c.default_meta_account_id} product=${String(c.product_id).slice(0,8)} campaign=${c.test_meta_campaign_id}`); }
  // accounts WITH active adsets (from scorecards)
  const {data:latest}=await admin.from("iteration_scorecards_daily").select("snapshot_date").eq("workspace_id",WS).eq("level","adset").order("snapshot_date",{ascending:false}).limit(1).maybeSingle();
  const {data:acctRows}=await admin.from("iteration_scorecards_daily").select("meta_ad_account_id").eq("workspace_id",WS).eq("level","adset").eq("snapshot_date",(latest as any)?.snapshot_date).eq("effective_status","ACTIVE");
  const activeAccts=[...new Set((acctRows||[]).map((r:any)=>String(r.meta_ad_account_id)))];
  console.log("\naccounts WITH active adsets:", activeAccts.join(", "));
  console.log("covered by a cohort:", activeAccts.map(a=>`${a.slice(0,10)}=${covered.has(a)?"YES":"NO ⚠️"}`).join(" · "));
  // fresh signal for the 2 dud accounts?
  for(const a of activeAccts){
    const fresh=await hasFreshMetaSignal(admin,WS,a).catch(()=>null);
    console.log(`  signal fresh @${a.slice(0,10)}: ${fresh}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
