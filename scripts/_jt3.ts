import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const {data}=await admin.from("agent_jobs").select("status,log_tail").eq("id","ce3183a2-2185-46f2-a6c1-84618ecbab3b").single();
  const d:any=data; console.log("status:",d?.status);
  const arr=JSON.parse(d?.log_tail??"[]");
  for(const r of arr){ console.log(`\n${r.ok?"✅":"❌"} "${r.angleHook}" ${r.ok?"→ "+r.campaignId:"("+r.reason+")"}`); if(r.qaIssues) for(const q of r.qaIssues) console.log(`    · ${q.slice(0,180)}`); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
