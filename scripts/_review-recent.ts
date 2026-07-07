import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  // the 5 proposed — how old?
  const { data: prop } = await db.from("sonnet_prompts").select("id,title,proposed_at,created_at,auto_decision,auto_decision_at").eq("status","proposed").order("proposed_at",{ascending:true});
  console.log("=== the 5 'proposed' (pending) ===");
  for(const r of prop||[]) console.log(`  proposed=${((r as any).proposed_at||(r as any).created_at||"").slice(0,16)} auto_decision=${(r as any).auto_decision??"(none)"} | ${((r as any).title||"").slice(0,55)}`);
  // recent auto-decisions — is the cron deciding lately?
  const { data: rec } = await db.from("sonnet_prompts").select("title,status,auto_decision,auto_decision_at,auto_decision_reason").not("auto_decision_at","is",null).order("auto_decision_at",{ascending:false}).limit(6);
  console.log("\n=== most recent auto-decisions (is the cron active?) ===");
  for(const r of rec||[]) console.log(`  ${((r as any).auto_decision_at||"").slice(0,16)} [${(r as any).auto_decision}→${(r as any).status}] ${((r as any).title||"").slice(0,45)} :: ${((r as any).auto_decision_reason||"").slice(0,60)}`);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
