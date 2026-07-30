import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const JOB = "30d4128c-3750-4e1a-b295-f143e038172b";
async function main(){
  const admin = createAdminClient();
  const { data } = await admin.from("agent_jobs").select("id,status,kind,spec_slug,updated_at,pending_actions").eq("id", JOB).maybeSingle();
  const j:any = data;
  console.log(`bianca plan job ${JOB}: status=${j?.status} updated=${j?.updated_at} actions=${(j?.pending_actions||[]).length}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
