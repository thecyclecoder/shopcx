import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const admin = createAdminClient();
  const { data } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,instructions,created_at")
    .eq("kind","ad-creative").order("created_at",{ascending:false}).limit(8);
  console.log(JSON.stringify(data, null, 2));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
