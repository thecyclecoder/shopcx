import { loadEnv } from "./_bootstrap"; loadEnv();
import { investigateGoal } from "../src/lib/spec-investigation";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const g:any=await investigateGoal(WS, "dahlia-imitate-then-innovate-copy-engine");
  const members=g?.members||g?.specs||[];
  console.log("=== goal investigate summary ===");
  console.log(JSON.stringify({inFlight:g?.inFlight, dispatchNext:g?.dispatchNext, blocked:g?.blocked, serializer:g?.serializer},null,2).slice(0,800));
  // Direct: active jobs for goal members
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs")
    .select("id,kind,spec_slug,status,claimed_at,updated_at,created_at,attempts")
    .eq("workspace_id",WS)
    .in("status",["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage"])
    .order("updated_at",{ascending:false}).limit(40);
  console.log("\n=== ACTIVE agent_jobs (all) ===");
  for(const j of jobs||[]) console.log(`  ${j.status.padEnd(14)} ${j.kind.padEnd(12)} ${j.spec_slug||"-"} | upd ${j.updated_at} claimed ${j.claimed_at||"-"} att ${j.attempts}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
