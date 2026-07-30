import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("creative_skeletons").select("status").eq("workspace_id",WS).limit(2000);
  const s=new Set((data??[]).map((r:any)=>r.status));
  console.log("distinct statuses in use:", JSON.stringify([...s]));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
