import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const applianceCamps = ["0b4d2ac6-3eac-4161-90ce-b912071070d8","0957c68f-d7fd-4759-93bd-b40766f27de3","780ee2c3-cb3f-44d7-9b64-14808d522a3f","ddb60370-ae60-40b5-9837-792a3a90a485"];
async function main(){
  const admin=createAdminClient();
  // any publish jobs for tonight's campaigns?
  const {data:pj}=await admin.from("ad_publish_jobs").select("campaign_id,publish_status,created_at")
    .gte("created_at","2026-07-13T05:30:00Z").order("created_at",{ascending:false}).limit(20);
  console.log(`publish jobs since 05:30: ${(pj??[]).length}`);
  for(const p of (pj??[]) as any[]) console.log(`  ${p.campaign_id} ${p.publish_status} ${p.created_at}`);
  // appliance campaigns current status
  const {data:c}=await admin.from("ad_campaigns").select("id,status").in("id",applianceCamps);
  console.log("\nappliance campaigns:");
  for(const r of (c??[]) as any[]) console.log(`  ${r.id} status=${r.status}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
