import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data: jobs } = await admin.from("agent_jobs").select("id,kind,status,actions,pending_actions")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-agent-test-mock-support-neq-filter").eq("status","needs_approval").limit(3);
  for(const j of (jobs||[]) as any[]){
    console.log(`job ${j.id} ${j.kind} ${j.status}`);
    console.log("  actions:", JSON.stringify(j.actions||j.pending_actions||"none").slice(0,400));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,150));process.exit(1);});
