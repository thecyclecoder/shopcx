import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main() {
  const admin = createAdminClient();
  const { data } = await admin.from("agent_jobs").select("log_tail,session_note,metadata").eq("id","4623c23e-9f94-4397-850b-bcbf46743816").single();
  const d:any=data;
  console.log("LOG_TAIL:\n", (d.log_tail??"").slice(-2500));
  console.log("\nSESSION_NOTE:", d.session_note);
  console.log("\nMETADATA:", JSON.stringify(d.metadata)?.slice(0,800));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
