import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACTIVE=["queued","claimed","building","queued_resume","needs_input","needs_approval","blocked_on_usage"];
(async()=>{
  const a=createAdminClient();
  for(const slug of ["control-tower-suppress-box-cron-freshness-during-worker-outage","dahlia-copy-author-box-session"]){
    const { data:jobs }=await a.from("agent_jobs").select("status,kind,updated_at").eq("workspace_id",WS).eq("spec_slug",slug).order("updated_at",{ascending:false}).limit(6);
    const active=(jobs||[]).filter((j:any)=>ACTIVE.includes(j.status));
    console.log(`${slug}:`);
    console.log(`  active jobs: ${active.map((j:any)=>j.kind+"/"+j.status).join(", ")||"NONE"}`);
    // is there a pr-resolve working the conflict?
    const pr=(jobs||[]).find((j:any)=>j.kind==="pr-resolve");
    console.log(`  latest states: ${(jobs||[]).slice(0,4).map((j:any)=>j.kind+"/"+j.status).join(", ")}`);
  }
})().then(()=>process.exit(0));
