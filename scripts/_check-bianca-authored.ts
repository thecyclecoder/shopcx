import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB = "30d4128c-3750-4e1a-b295-f143e038172b";
async function main(){
  const admin = createAdminClient();
  const { data: job } = await admin.from("agent_jobs").select("status,updated_at").eq("id", JOB).maybeSingle();
  console.log(`job status=${(job as any)?.status} updated=${(job as any)?.updated_at}`);
  const s:any = await getSpec(WS, "bianca-cold-test-recent-purchaser-exclusion");
  console.log(`M2 exclusion spec authored? ${s ? "YES" : "not yet"}`);
  if (s) console.log(`  phases: ${(s.phases||[]).map((p:any)=>p.status).join("/")}  blocked_by=${JSON.stringify(s.blocked_by)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
