import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueBuildIfDue, evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const r=await enqueueBuildIfDue(WS,"dahlia-copy-author-box-session",{createdBy:null});
  console.log("enqueue head:", JSON.stringify(r));
  console.log("dispatch(head):", JSON.stringify(await evaluateGoalMemberBuildDispatch(WS,"dahlia-copy-author-box-session")));
  const admin=createAdminClient();
  const { data:hj }=await admin.from("agent_jobs").select("id,status,updated_at").eq("workspace_id",WS)
    .eq("kind","build").eq("spec_slug","dahlia-copy-author-box-session").order("updated_at",{ascending:false}).limit(3);
  console.log("head jobs:", JSON.stringify(hj));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
