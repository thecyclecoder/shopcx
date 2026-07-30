import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("agent_jobs")
    .select("*").eq("id","4623c23e-9f94-4397-850b-bcbf46743816").single();
  if(error){console.error("ERR", error.message);return;}
  const d:any=data;
  console.log("columns:", Object.keys(d).join(", "));
  for (const k of ["status","result","error","summary","result_summary","output","artifacts","logs"]) {
    if (k in d) console.log(`\n${k}:`, JSON.stringify(d[k])?.slice(0,1500));
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
