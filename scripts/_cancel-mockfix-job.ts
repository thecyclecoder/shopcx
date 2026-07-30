import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB="552fb7ed-1949-4139-be08-4216e8662ecd";
(async()=>{
  const admin=createAdminClient();
  const { error } = await admin.from("agent_jobs")
    .update({ status: "cancelled", error: "Spec folded as obsolete (CEO 2026-07-14): test:media-buyer-agent already passes on main, the mock .neq fix is unnecessary. Do not re-drive/merge." })
    .eq("id", JOB).eq("workspace_id", WS);
  console.log(error ? `ERR: ${error.message}` : `✓ cancelled build job ${JOB.slice(0,8)}`);
  // verify no open jobs remain for the mock-fix spec
  const { data } = await admin.from("agent_jobs").select("id,kind,status")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-agent-test-mock-support-neq-filter")
    .in("status",["needs_approval","needs_attention","queued","claimed","building","queued_resume"]);
  console.log(`open jobs remaining: ${data?.length||0}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
