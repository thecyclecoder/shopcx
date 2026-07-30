import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const a=createAdminClient();
  for(const t of ["agent_action_requests","competitor_ads","ad_breakdowns"]){
    const {count,error}=await a.from(t).select("*",{count:"exact",head:true});
    console.log(`  ${t}: ${error?"ERR "+error.message:count+" rows (admin OK)"}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
