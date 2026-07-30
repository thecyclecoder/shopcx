import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("agent_jobs").select("status").eq("id",process.argv[2]).single();
  console.log(data?.status??"unknown");
}
main().then(()=>process.exit(0)).catch(()=>process.exit(1));
