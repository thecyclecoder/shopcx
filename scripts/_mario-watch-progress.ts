import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = ["spec-timecard-ledger-and-sdk","spec-timecard-chokepoint-instrumentation","mario-stall-detector-cron-and-thresholds","mario-reactive-box-agent","spec-detail-timecard-timeline"];
async function snap(admin:ReturnType<typeof createAdminClient>){
  const { data } = await admin.from("agent_jobs").select("spec_slug,kind,status,created_at").eq("workspace_id",WS).in("spec_slug",SLUGS).order("created_at",{ascending:false});
  const latest=new Map<string,string>();
  for(const j of (data??[]) as {spec_slug:string;kind:string;status:string}[]) if(!latest.has(j.spec_slug)) latest.set(j.spec_slug,`${j.kind}:${j.status}`);
  return SLUGS.map(s=>`${s.split("-").slice(-2).join("-")}=${latest.get(s)??"—"}`).join(" | ");
}
async function main(){
  const admin=createAdminClient();
  let prev="";
  for(let i=0;i<60;i++){
    const cur=await snap(admin);
    // gate detection
    const { data:gate } = await admin.from("agent_jobs").select("spec_slug,kind").eq("workspace_id",WS).in("spec_slug",SLUGS).in("status",["needs_approval","needs_input","needs_attention"]).limit(1);
    if(cur!==prev){ console.log(`[t+${i*30}s] ${cur}`); prev=cur; }
    if((gate??[]).length){ console.log(`GATE: ${gate![0].kind} on ${gate![0].spec_slug} needs you`); process.exit(0); }
    await new Promise(r=>setTimeout(r,30000));
  }
  console.log("watch window ended (30 min)"); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
