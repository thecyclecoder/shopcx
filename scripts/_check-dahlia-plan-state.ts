import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const JOB = "e3223795-070e-477b-b4b7-44a663ac27f7";
async function main() {
  const admin = createAdminClient();
  const { data: job } = await admin.from("agent_jobs")
    .select("id,status,kind,spec_slug,updated_at,pending_actions").eq("id", JOB).maybeSingle();
  if (!job) { console.log("job not found"); return; }
  const j:any = job;
  const acts = (j.pending_actions || []) as any[];
  console.log(`job ${JOB}\n status=${j.status} kind=${j.kind} updated=${j.updated_at}\n actions=${acts.length}`);
  const byStatus: Record<string,number> = {};
  for (const a of acts) byStatus[a.status] = (byStatus[a.status]||0)+1;
  console.log(" status counts:", JSON.stringify(byStatus));
  for (const a of acts) console.log(`   [${a.status}] ${a.spec?.slug ?? a.id}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
