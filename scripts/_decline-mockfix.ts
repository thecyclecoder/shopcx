import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // find the stuck build job + inspect its columns for a pending action
  const { data: jobs } = await admin.from("agent_jobs").select("*")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-agent-test-mock-support-neq-filter")
    .in("status",["needs_approval","needs_attention","queued","claimed","building","queued_resume"]);
  console.log(`open jobs for mock-fix: ${jobs?.length||0}`);
  for(const j of (jobs||[]) as any[]){
    const actionKeys=Object.keys(j).filter(k=>/action|approv|pending|cmd/i.test(k));
    console.log(`\n  job ${j.id} kind=${j.kind} status=${j.status}`);
    for(const k of actionKeys) if(j[k]) console.log(`    ${k}: ${JSON.stringify(j[k]).slice(0,250)}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
