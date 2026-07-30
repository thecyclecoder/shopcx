import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/60000).toFixed(0)}m`:"—";
(async()=>{
  const admin=createAdminClient();
  const { data } = await admin.from("agent_jobs").select("id,status,updated_at,error").eq("workspace_id",WS)
    .eq("spec_slug","bianca-cold-scaler-cohort-and-daily-ceiling").eq("kind","build").order("updated_at",{ascending:false}).limit(4);
  console.log("bianca-cold-scaler-cohort-and-daily-ceiling build jobs:");
  for(const j of data||[]) console.log(`  [${j.status}] ${ago(j.updated_at)} err=${String(j.error??"").slice(0,80)}`);
  const disp = await evaluateGoalMemberBuildDispatch(WS,"bianca-cold-scaler-cohort-and-daily-ceiling");
  console.log("dispatch verdict for the head:", JSON.stringify(disp));
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
