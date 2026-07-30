import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const JOB = "30d4128c-3750-4e1a-b295-f143e038172b";
async function main(){
  const admin = createAdminClient();
  const { data } = await admin.from("agent_jobs").select("pending_actions").eq("id", JOB).maybeSingle();
  const acts = ((data as any)?.pending_actions||[]) as any[];
  acts.forEach((a,i)=>{
    const s = a.spec||{};
    console.log(`\n[${i}] ${a.status}  ${s.slug}`);
    console.log(`    milestone: ${s.milestone ?? "-"}   parent: ${s.parent ?? "-"}`);
    console.log(`    title: ${s.title ?? "-"}`);
    console.log(`    intent: ${(s.intent||s.gap||"").slice(0,400)}`);
    if (s.blocked_by) console.log(`    blocked_by: ${JSON.stringify(s.blocked_by)}`);
  });
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
