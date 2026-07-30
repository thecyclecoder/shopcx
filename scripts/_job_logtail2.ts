import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("agent_jobs").select("status,log_tail").eq("id","5d751f29-f521-4bde-9690-017a1e958f7f").single();
  const d:any=data; console.log("status:",d?.status); console.log((d?.log_tail??"").slice(-2600));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
