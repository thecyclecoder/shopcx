import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // 1. Dahlia kill switch state
  const { data:sw }=await admin.from("kill_switches").select("key,enabled,scope,updated_at")
    .or("key.ilike.%dahlia%,key.ilike.%ad-creative%,key.ilike.%ad_creative%");
  console.log("=== Dahlia / ad-creative kill switches ===");
  for(const s of sw||[]) console.log(`  ${s.key.padEnd(40)} enabled=${s.enabled} scope=${s.scope||"-"}`);
  if(!(sw||[]).length) console.log("  (none found by name — checking any switch mentioning creative)");
  // 2. build jobs blocked on approval (migration/fork) to unblock
  const { data:jobs }=await admin.from("agent_jobs").select("id,spec_slug,status,pending_actions")
    .eq("kind","build").in("status",["needs_approval","needs_input"]);
  console.log("\n=== BUILD jobs blocked on approval/input ===", (jobs||[]).length);
  for(const j of jobs||[]){
    console.log(`  ${j.status} ${j.spec_slug} :: ${JSON.stringify(j.pending_actions||[]).slice(0,220)}`);
  }
})().then(()=>process.exit(0));
