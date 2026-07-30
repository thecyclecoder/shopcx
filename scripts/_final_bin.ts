import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE="ea433e56-0aa4-4b46-9107-feb11f77f533", TABS="221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main(){
  const admin=createAdminClient();
  const {readyToTest}=await listReadyToTest(admin,{workspaceId:WS});
  // map campaign->product
  const ids=readyToTest.map(r=>r.ad_campaign_id);
  const {data:camps}=await admin.from("ad_campaigns").select("id,product_id,created_at").in("id",ids);
  const byId=new Map((camps??[]).map((c:any)=>[c.id,c]));
  let coffee=0,tabs=0,other=0;
  for(const r of readyToTest){ const p=(byId.get(r.ad_campaign_id) as any)?.product_id; if(p===COFFEE)coffee++; else if(p===TABS)tabs++; else other++; }
  console.log(`Ready-to-test bin (staged, not launched):`);
  console.log(`  Amazing Coffee: ${coffee}`);
  console.log(`  Superfood Tabs: ${tabs}`);
  console.log(`  other products: ${other}`);
  console.log(`  TOTAL: ${readyToTest.length}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
