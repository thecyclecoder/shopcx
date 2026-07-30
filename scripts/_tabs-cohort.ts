import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_PID="221d272d-a6c5-4a5d-86ff-ac693926c992";
(async()=>{
  const admin=createAdminClient();
  const {data:cohorts}=await admin.from("media_buyer_test_cohorts").select("*")
    .eq("workspace_id",WS).eq("product_id",TABS_PID).order("created_at",{ascending:false});
  console.log(`Tabs cohorts: ${cohorts?.length||0}`);
  for(const c of (cohorts||[]) as any[]){
    console.log(`\n▸ cohort ${c.id.slice(0,8)} active=${c.is_active} created=${c.created_at?.slice(0,10)}`);
    console.log(`  test_meta_campaign_id: ${c.test_meta_campaign_id}`);
    console.log(`  adset_template: ${c.adset_template?JSON.stringify(c.adset_template).slice(0,160):"NULL"}`);
    console.log(`  per_test_daily_budget_cents: ${c.per_test_daily_budget_cents} | daily_test_ceiling_cents: ${c.daily_test_ceiling_cents} | adset_per_test: ${c.adset_per_test}`);
  }
  // How many ANGLED ready creatives does Tabs have to draw from?
  const {data:creatives}=await admin.from("ad_campaigns").select("id,name,angle_id,status")
    .eq("workspace_id",WS).eq("product_id",TABS_PID).eq("status","ready");
  const angled=(creatives||[]).filter((c:any)=>c.angle_id);
  console.log(`\nTabs ready creatives: ${creatives?.length||0} total, ${angled.length} WITH angle (usable by replenish)`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,250));process.exit(1);});
