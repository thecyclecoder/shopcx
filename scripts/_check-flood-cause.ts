import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:mj }=await admin.from("agent_jobs").select("spec_slug,instructions").eq("kind","mario").eq("status","queued").limit(6);
  for(const j of mj||[]){
    let pr=null; try{ pr=JSON.parse(j.instructions||"{}").job_pr_context?.pr_number; }catch{}
    if(!pr){ console.log(`${j.spec_slug}: no pr in brief`); continue; }
    const { data:builds }=await admin.from("agent_jobs").select("status").eq("workspace_id",WS).eq("kind","build").eq("pr_number",pr);
    const statuses=(builds||[]).map(b=>b.status);
    console.log(`${j.spec_slug} pr#${pr} build-statuses=[${statuses.join(",")}] hasMerged=${statuses.includes("merged")}`);
  }
})().then(()=>process.exit(0));
