import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS="221d272d-a6c5-4a5d-86ff-ac693926c992";
(async()=>{
  const admin=createAdminClient();
  // 1. Tabs cohort
  const {data:coh}=await admin.from("media_buyer_test_cohorts")
    .select("product_id, meta_ad_account_id, test_meta_campaign_id, test_meta_adset_id, is_active, per_test_daily_budget_cents, cohort_target_count")
    .eq("workspace_id",WS).eq("product_id",TABS);
  console.log("COHORT:", JSON.stringify(coh,null,1));
  // 2. policy mode (shadow vs armed)
  const {data:pol}=await admin.from("iteration_policies")
    .select("id, mode, status, trust_meta_reported_signal, created_at")
    .eq("workspace_id",WS).eq("status","active").order("created_at",{ascending:false}).limit(3);
  console.log("ACTIVE POLICIES:", JSON.stringify(pol,null,1));
  // 3. ready bin for Tabs (SDK) — genuine minus archived
  const {readyToTest}=await listReadyToTest(admin,{workspaceId:WS,productId:TABS});
  console.log(`\nlistReadyToTest(Tabs) → ${readyToTest.length} rows (NOTE: pre-#29 still counts archived)`);
  // 4. recent media-buyer activity for Tabs
  const {data:acts}=await admin.from("director_activity")
    .select("action_kind, reason, created_at, metadata")
    .eq("workspace_id",WS).like("action_kind","%media_buyer%").order("created_at",{ascending:false}).limit(6);
  console.log("\nRECENT MEDIA-BUYER ACTIVITY:");
  for(const a of (acts||[]) as any[]) console.log(`  ${a.created_at?.slice(0,16)} ${a.action_kind} — ${(a.reason||"").slice(0,110)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
