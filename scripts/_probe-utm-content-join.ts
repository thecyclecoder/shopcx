import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin = createAdminClient();
  const contentIds = ["120249298364860682","120250066837240326","120252355818090184","120248805815160378","120249262234160682","120252200325730184"];
  // 1) do these appear as meta_ad_id in ad_publish_jobs?
  const { data: byAd } = await admin.from("ad_publish_jobs")
    .select("meta_ad_id, meta_adset_id, meta_campaign_id, ad_name").eq("workspace_id", WS).in("meta_ad_id", contentIds);
  console.log(`ad_publish_jobs matched by meta_ad_id: ${byAd?.length ?? 0}`);
  for (const p of byAd||[]) console.log(`   ad=${p.meta_ad_id} adset=${p.meta_adset_id} campaign=${p.meta_campaign_id} "${p.ad_name}"`);
  // 2) fallback: maybe content id is an adset id
  const { data: byAdset } = await admin.from("ad_publish_jobs")
    .select("meta_ad_id, meta_adset_id, meta_campaign_id, ad_name").eq("workspace_id", WS).in("meta_adset_id", contentIds);
  console.log(`\nmatched by meta_adset_id: ${byAdset?.length ?? 0}`);
  for (const p of byAdset||[]) console.log(`   adset=${p.meta_adset_id} campaign=${p.meta_campaign_id} "${p.ad_name}"`);
  // 3) meta_ads table? meta_insights_daily by object id
  const { data: mi } = await admin.from("meta_insights_daily")
    .select("meta_object_id, level").eq("workspace_id", WS).in("meta_object_id", contentIds).limit(20);
  console.log(`\nmeta_insights_daily rows for these ids: ${mi?.length ?? 0} · levels: ${[...new Set((mi||[]).map((x:any)=>x.level))].join(",")}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
