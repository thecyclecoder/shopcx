import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs, error }=await admin.from("agent_jobs")
    .select("id,status,kind,error,updated_at,created_at,pr_number")
    .eq("workspace_id",WS).eq("spec_slug","dahlia-copy-author-box-session")
    .order("created_at",{ascending:false}).limit(8);
  if(error){ console.log("ERR", error.message); return; }
  console.log("jobs:", (jobs||[]).length);
  for(const j of jobs||[]) console.log(`  ${j.kind.padEnd(10)} ${j.status.padEnd(14)} pr=${j.pr_number||"-"} upd=${j.updated_at}\n     err=${String(j.error||"").slice(0,280)}`);
})().then(()=>process.exit(0));
