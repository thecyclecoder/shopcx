import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
const JOB = "4623c23e-9f94-4397-850b-bcbf46743816";
const START = "2026-07-13T06:00:00Z";
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main() {
  const admin = createAdminClient();
  for (let i=0;i<40;i++){
    const { data: job } = await admin.from("agent_jobs").select("status,error,updated_at").eq("id",JOB).single();
    // count new coffee ready creatives since START
    const { data: camps } = await admin.from("ad_campaigns")
      .select("id,created_at,status").eq("workspace_id",WS).eq("product_id",COFFEE)
      .gte("created_at",START).order("created_at",{ascending:false});
    console.log(`[t+${i*30}s] job=${job?.status} newCoffeeCampaigns=${(camps??[]).length} :: ${job?.error??""}`);
    if (job && ["completed","failed","cancelled"].includes(job.status)) {
      console.log("=== TERMINAL ===", job.status, job.error??"");
      break;
    }
    await sleep(30000);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
