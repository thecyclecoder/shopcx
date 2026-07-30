import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const db=createAdminClient();
  const {error}=await db.from("agent_jobs").update({status:"cancelled",log_tail:"Cancelled — spec-tests are machine-run (no session); the ✗1 is test:media-buyer-agent failing on #29's .neq, fixed at the machine-check level."}).eq("id","451a6231-901b-4ea4-9f83-032dcb2e08c6").in("status",["queued","claimed","building"]);
  console.log(error?`cancel failed: ${error.message}`:"✓ cancelled errant spec-test job 451a6231");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
