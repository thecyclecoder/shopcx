import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:mj }=await admin.from("agent_jobs").select("spec_slug,instructions,created_at").eq("kind","mario").eq("status","queued").order("created_at",{ascending:false}).limit(5);
  const cutoff=Date.now()-7*24*3600*1000;
  for(const j of mj||[]){
    let pr=null; try{ pr=JSON.parse(j.instructions||"{}").job_pr_context?.pr_number; }catch{}
    console.log(`\nmario job created ${j.created_at} spec=${j.spec_slug} pr=${pr}`);
    if(!pr) continue;
    const { data:b }=await admin.from("agent_jobs").select("status,updated_at").eq("workspace_id",WS).eq("kind","build").eq("pr_number",pr).order("updated_at",{ascending:false}).limit(3);
    for(const r of b||[]) console.log(`   build ${r.status} updated_at=${r.updated_at} within7d=${Date.parse(r.updated_at)>cutoff}`);
  }
})().then(()=>process.exit(0));
