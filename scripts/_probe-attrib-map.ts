import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin = createAdminClient();
  const testCampaigns = ["120248805655650378","120249256874270682","120250066504550326","120252353694390184","120252196683350184","120249298361370682"];
  const contentIds = ["120249298364860682","120250066837240326","120252355818090184","120248805815160378","120249262234160682","120252200325730184"];
  // ad -> campaign map via meta_attribution_daily
  const { data } = await admin.from("meta_attribution_daily")
    .select("meta_ad_id, meta_adset_id, meta_campaign_id").eq("workspace_id", WS).in("meta_ad_id", contentIds);
  const map = new Map<string,string>();
  for (const r of data||[]) if (r.meta_ad_id && r.meta_campaign_id) map.set(String(r.meta_ad_id), String(r.meta_campaign_id));
  console.log("ad_id -> campaign_id (via meta_attribution_daily):");
  for (const c of contentIds){ const camp = map.get(c); console.log(`   ${c} -> ${camp ?? "NOT FOUND"} ${camp && testCampaigns.includes(camp) ? "[TEST]" : ""}`); }
  // full: how many distinct test ad-ids exist under the 6 test campaigns?
  const { data: all } = await admin.from("meta_attribution_daily")
    .select("meta_ad_id").eq("workspace_id", WS).in("meta_campaign_id", testCampaigns);
  console.log(`\ndistinct ad-ids under the 6 test campaigns (meta_attribution_daily): ${new Set((all||[]).map((x:any)=>String(x.meta_ad_id))).size}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
