import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueBuildIfDue, evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // 1. find deeper's queued build job(s)
  const { data:jobs }=await admin.from("agent_jobs")
    .select("id,status,claimed_at,updated_at").eq("workspace_id",WS)
    .eq("kind","build").eq("spec_slug","dahlia-deeper-competitor-selection")
    .in("status",["queued","claimed"]);
  console.log("deeper queued/claimed jobs:", JSON.stringify(jobs));
  for(const j of jobs||[]){
    const { error }=await admin.from("agent_jobs").update({
      status:"cancelled",
      error:"re-drive (ceo:dylan 2026-07-16): yielding goal admission to earliest-ready head dahlia-copy-author-box-session to break a two-gate deadlock (admission counts queued as in-flight; dispatcher does not). Deeper has no blockers → re-enqueues when it becomes earliest-ready.",
      questions:[], pending_actions:[], updated_at:new Date().toISOString(),
    }).eq("id",j.id);
    console.log(`  cancelled ${j.id}`, error?("ERR "+error.message):"ok");
  }
  // 2. admit the head now
  const r=await enqueueBuildIfDue(WS,"dahlia-copy-author-box-session",{createdBy:"ceo:dylan"});
  console.log("enqueue head:", JSON.stringify(r));
  console.log("dispatch(head):", JSON.stringify(await evaluateGoalMemberBuildDispatch(WS,"dahlia-copy-author-box-session")));
  // 3. show head's job
  const { data:hj }=await admin.from("agent_jobs").select("id,status,updated_at").eq("workspace_id",WS)
    .eq("kind","build").eq("spec_slug","dahlia-copy-author-box-session").in("status",["queued","claimed","building"]);
  console.log("head job now:", JSON.stringify(hj));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
