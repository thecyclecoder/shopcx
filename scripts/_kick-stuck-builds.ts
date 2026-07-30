import { loadEnv } from "./_bootstrap"; loadEnv();
import { enqueueBuildIfDue, autoQueueUnblockedByGoal } from "../src/lib/agent-jobs";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/60000).toFixed(0)}m`:"—";
(async()=>{
  // 1) Dahlia keystone — nothing Dahlia in-flight, should enqueue
  const r = await enqueueBuildIfDue(WS, "dahlia-conversion-psychology-rubric-module", { createdBy:null });
  console.log("rubric enqueueBuildIfDue:", JSON.stringify(r));

  // 2) re-run the goal reconciler for both goals (sanctioned sweep, respects serializer)
  const dahliaQ = await autoQueueUnblockedByGoal(WS, "dahlia-imitate-then-innovate-copy-engine");
  console.log("dahlia autoQueueUnblockedByGoal ->", JSON.stringify(dahliaQ));
  const biancaQ = await autoQueueUnblockedByGoal(WS, "bianca-temperature-aware-campaign-structure");
  console.log("bianca autoQueueUnblockedByGoal ->", JSON.stringify(biancaQ));

  // 3) re-probe active build jobs
  const admin=createAdminClient();
  const { data } = await admin.from("agent_jobs").select("spec_slug,status,updated_at").eq("workspace_id",WS).eq("kind","build")
    .in("status",["queued","claimed","building","queued_resume"]).order("updated_at",{ascending:false});
  console.log("\nactive build jobs now:");
  for(const j of data||[]) console.log(`  [${j.status}] ${j.spec_slug} ${ago(j.updated_at)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
