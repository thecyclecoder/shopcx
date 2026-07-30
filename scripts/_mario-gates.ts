import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["spec-timecard-ledger-and-sdk","spec-timecard-chokepoint-instrumentation","mario-stall-detector-cron-and-thresholds","mario-reactive-box-agent","spec-detail-timecard-timeline"];
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("agent_jobs").select("spec_slug,kind,status,session_note").eq("workspace_id",WS).in("spec_slug",SLUGS).in("status",["needs_approval","needs_input","needs_attention","building"]).order("created_at",{ascending:false});
  if(!(data??[]).length){ console.log("no active/gated jobs"); return; }
  for(const j of data as any[]) console.log(`  [${j.status}] ${j.kind} ${j.spec_slug} :: ${j.session_note??""}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
