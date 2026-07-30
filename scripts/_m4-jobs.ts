import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
const { data }=await admin.from("agent_jobs").select("kind,status,created_at,session_note").eq("workspace_id",WS).eq("spec_slug","mario-reactive-box-agent").order("created_at",{ascending:false}).limit(6);
for(const j of (data??[]) as any[]) console.log(`  [${j.status}] ${j.kind}  ${j.session_note?"— "+String(j.session_note).slice(0,60):""}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
