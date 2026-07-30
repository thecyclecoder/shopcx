import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs").select("spec_slug,instructions")
    .eq("kind","mario").eq("spec_slug","ticket-decision-workprobe-exclude-active-playbook").order("created_at",{ascending:false}).limit(1);
  for(const j of jobs||[]){
    console.log("spec:", j.spec_slug);
    console.log("brief:", JSON.stringify(JSON.parse(j.instructions||"{}"),null,1));
  }
  // does this spec have an OPEN orphaned PR? (the orphaned_folded_pr detector's precondition)
  const { data:builds }=await admin.from("agent_jobs").select("id,status,pr_number,updated_at")
    .eq("workspace_id",WS).eq("spec_slug","ticket-decision-workprobe-exclude-active-playbook").eq("kind","build").not("pr_number","is",null).order("updated_at",{ascending:false}).limit(5);
  console.log("\nbuild jobs w/ pr_number:", JSON.stringify(builds));
})().then(()=>process.exit(0));
