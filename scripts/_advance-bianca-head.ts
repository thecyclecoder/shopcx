import { loadEnv } from "./_bootstrap"; loadEnv();
import { enqueueBuildIfDue, queueNextChainedPhase } from "../src/lib/agent-jobs";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const HEAD="bianca-cold-scaler-cohort-and-daily-ceiling";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/60000).toFixed(0)}m`:"—";
(async()=>{
  const r1 = await enqueueBuildIfDue(WS, HEAD, {createdBy:null});
  console.log("enqueueBuildIfDue(head):", JSON.stringify(r1));
  if(!r1.enqueued){
    const r2 = await queueNextChainedPhase(WS, HEAD);
    console.log("queueNextChainedPhase(head):", JSON.stringify(r2));
  }
  const admin=createAdminClient();
  const { data } = await admin.from("agent_jobs").select("spec_slug,status,updated_at").eq("workspace_id",WS).eq("kind","build")
    .in("status",["queued","claimed","building","queued_resume"]).order("updated_at",{ascending:false});
  console.log("\nactive build jobs now:"); for(const j of data||[]) console.log(`  [${j.status}] ${j.spec_slug} ${ago(j.updated_at)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
