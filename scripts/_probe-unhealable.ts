import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  // needs_attention builds past 2 redrives
  const { data:na }=await a.from("agent_jobs").select("id,spec_slug,needs_attention_class,error").eq("workspace_id",WS).eq("kind","build").eq("status","needs_attention");
  const stuck:string[]=[];
  for(const j of na||[]){
    const { data:prior }=await a.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",j.spec_slug).eq("status","cancelled").ilike("error","%watchdog-redrive%");
    if((prior||[]).length>=2) stuck.push(`${j.spec_slug} [${j.needs_attention_class||"?"}]`);
  }
  console.log("needs_attention builds past 2-redrive cap:", stuck.length, stuck.length?"→ "+stuck.join(", "):"");
  // build-blocking approvals with NON-auto-approvable types
  const { data:blk }=await a.from("agent_jobs").select("id,spec_slug,pending_actions").eq("workspace_id",WS).eq("kind","build").eq("status","needs_approval");
  const AUTO=["apply_migration","design_fork","design_decision"];
  const novel:string[]=[];
  for(const j of blk||[]) for(const act of (j.pending_actions as any[])||[]) if(act.status==="pending"&&!AUTO.includes(act.type)) novel.push(`${j.spec_slug}: ${act.type}`);
  console.log("build approvals with NEW (non-auto) types:", novel.length, novel.length?"→ "+novel.join(", "):"");
})().then(()=>process.exit(0));
