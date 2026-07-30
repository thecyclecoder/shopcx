import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs")
    .select("id,status,kind,attempts,pr_number,branch,error,updated_at,created_at")
    .eq("workspace_id",WS).eq("spec_slug","dahlia-copy-author-box-session").eq("kind","build")
    .order("created_at",{ascending:false}).limit(5);
  for(const j of jobs||[]) console.log(`build ${j.id.slice(0,8)} ${j.status} att=${j.attempts} pr=${j.pr_number||"-"} branch=${j.branch||"-"}\n   upd=${j.updated_at}\n   err=${String(j.error||"").slice(0,300)}\n`);
})().then(()=>process.exit(0));
