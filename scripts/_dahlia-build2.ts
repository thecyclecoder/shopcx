import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs, error }=await admin.from("agent_jobs")
    .select("id,status,kind,attempts,error,updated_at,created_at")
    .eq("workspace_id",WS).eq("spec_slug","dahlia-copy-author-box-session")
    .order("created_at",{ascending:false}).limit(8);
  if(error) console.log("ERR", error.message);
  console.log("jobs for dahlia-copy-author-box-session:", (jobs||[]).length);
  for(const j of jobs||[]) console.log(`  ${j.kind} ${j.status} att=${j.attempts} upd=${j.updated_at}\n     err=${String(j.error||"").slice(0,260)}`);
})().then(()=>process.exit(0));
