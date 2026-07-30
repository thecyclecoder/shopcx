import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main(){
  const admin=createAdminClient();
  // full column list of one appliance skeleton
  const {data:one}=await admin.from("creative_skeletons").select("*").eq("id","905a4e53-5b48-4cdf-afa5-68db08bdaf77").single();
  console.log("appliance skeleton columns:", Object.keys(one??{}).join(", "));
  const o:any=one;
  console.log("appliance domain fields:", JSON.stringify({advertiser:o.advertiser, destination_domain:o.destination_domain, landing_page_url:o.landing_page_url, competitor_id:o.competitor_id, search_keyword:o.search_keyword}));
  // The Tabs competitors
  const {data:comps}=await admin.from("competitors").select("id,domain,resolved_advertiser,search_keyword,status")
    .eq("workspace_id",WS).eq("product_id",TABS);
  console.log("\nTabs competitors:");
  for(const c of (comps??[]) as any[]) console.log(`  ${c.id} dom=${c.domain} adv=${c.resolved_advertiser} kw=${c.search_keyword} st=${c.status}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
