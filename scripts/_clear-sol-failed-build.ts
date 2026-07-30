import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
// The two stale FAILED build jobs for the archived sol spec. Clear (cancel) — do NOT retry.
const IDS=["707bf295-a58f-4326-b5cc-46126179b5b7","b6ec8eb2-e022-4170-a3e1-42a75e89acc2"];
(async()=>{
  const db=createAdminClient();
  for(const id of IDS){
    const {error,data}=await db.from("agent_jobs").update({
      status:"cancelled",
      needs_attention_class:null,
      log_tail:"Cleared by CEO request — stale FAILED build (env error: tsc/npx spawn) for an ARCHIVED spec whose work already shipped (goal folded 6d ago; 3 sibling build jobs completed). Cancelled, NOT retried — retrying a 6d-old build would risk overwriting Sol's current work.",
    }).eq("id",id).eq("status","failed").select("id");
    console.log(error?`FAIL ${id}: ${error.message}`:((data||[]).length?`✓ cleared ${id}`:`(already non-failed) ${id}`));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
