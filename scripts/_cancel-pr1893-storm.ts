/**
 * One-off: cancel the pr-resolve retry-storm jobs for PR #1893 (now CLOSED as superseded).
 * 61 needs_attention pr-resolve jobs re-spawned every ~7min for 7h, starving the build claim
 * loop. Founder-approved 2026-07-16 as part of the stall unblock. Dry by default; APPLY=1.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.env.APPLY==="1";
(async()=>{
  const admin=createAdminClient();
  const { data } = await admin.from("agent_jobs").select("id,pr_number,status")
    .eq("workspace_id",WS).eq("kind","pr-resolve").eq("status","needs_attention").eq("pr_number",1893);
  console.log(`pr-1893 needs_attention pr-resolve jobs: ${data?.length??0}`);
  if(!APPLY){ console.log("DRY RUN — APPLY=1 to cancel."); return; }
  let n=0;
  for(const j of data||[]){
    const { error } = await admin.from("agent_jobs")
      .update({ status:"completed", error:"pr-resolve storm cancelled — PR #1893 closed as superseded (spec already shipped/folded)", questions:[], pending_actions:[], updated_at:new Date().toISOString() })
      .eq("id",j.id);
    if(!error) n++;
  }
  console.log(`cancelled ${n} storm job(s).`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
