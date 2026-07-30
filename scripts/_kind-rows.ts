import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
for(const k of ["ticket-handle","ticket-analyze","prompt-review","playbook-compile","ticket-improve","triage-escalation"]){
const {count}=await db.from("agent_jobs").select("*",{count:"exact",head:true}).eq("kind",k);
console.log(`  ${k}: ${count} agent_jobs rows`);}process.exit(0);})();
