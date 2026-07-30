import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("agent_jobs").select("status,log_tail").eq("id",process.argv[2]).single();
  const d:any=data; console.log("status:",d?.status);
  const arr=JSON.parse(d?.log_tail??"[]");
  let ok=0; for(const r of arr){ if(r.ok)ok++; console.log(`${r.ok?"✅":"❌"} "${r.angleHook}"${r.ok?" → "+r.campaignId:" ("+(r.qaIssues?.[0]?.slice(0,140)??r.reason)+")"}`); }
  console.log(`\nLANDED: ${ok}/${arr.length}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
