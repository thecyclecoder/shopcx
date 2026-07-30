import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSlackToken, postAsGrowthDirector } from "../src/lib/slack";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906"; const CH="C0BFW5YUVC1";
(async()=>{
  const admin=createAdminClient();
  const {data:tc}=await admin.from("media_buyer_test_cohorts").select("adset_template,test_meta_campaign_id").eq("workspace_id",WS).eq("product_id","221d272d-a6c5-4a5d-86ff-ac693926c992").eq("is_active",true).maybeSingle();
  const t:any=(tc as any)?.adset_template;
  console.log("Tabs cohort template:", t?.pixelId?`SET ✓ (pixel ${t.pixelId}, ${t.optimizationGoal})`:"STILL NULL");
  console.log("Tabs campaign:", (tc as any)?.test_meta_campaign_id);
  if(t?.pixelId){
    const token=await getSlackToken(WS);
    const r=await postAsGrowthDirector(token!,CH,[],"*Tabs unblocked (hotfix):* founder-authorized — set the Superfood Tabs cohort `adset_template` directly (the shipped spec's backfill never executed). Template now matches the 5 other cohorts (pixel `468487900426092`, OFFSITE_CONVERSIONS/PURCHASE). Bianca can now mint the 2 missing Tabs test adsets on her next pass — the bin has 8 angled creatives ready. Task #31 (Tabs 2/4) resolved.");
    console.log(r.ok?`posted ts=${r.ts}`:"post failed");
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
