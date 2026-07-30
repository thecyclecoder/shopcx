import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
async function main() {
  const admin = createAdminClient();
  const { data } = await admin.from("agent_jobs")
    .select("id,status,spec_slug,instructions,created_at,updated_at,error")
    .eq("kind","ad-creative")
    .ilike("instructions", `%${COFFEE}%`)
    .order("created_at",{ascending:false}).limit(5);
  console.log(JSON.stringify(data, null, 2));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
