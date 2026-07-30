import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  // regression job → superseded by the authored mock-fix spec
  const {error:e1}=await db.from("agent_jobs").update({
    status:"completed", needs_attention_class:null,
    log_tail:"Superseded by spec media-buyer-agent-test-mock-support-neq-filter (authored 2026-07-13) — adds .neq to the agent.test.ts query mock, the exact fix for the test:media-buyer-agent .neq TypeError. Builds+merges → test green → the digest spec's ✗1 clears.",
  }).eq("id","4e053f3e-2960-4cf9-96ba-e9ea787c46cf").eq("status","needs_attention");
  console.log(e1?`reg FAIL: ${e1.message}`:"✓ regression job superseded by mock-fix spec");
  // storefront fizzle sessions → cancelled (outage artifacts; NOT touching the optimizer itself per #23)
  const {data:sf}=await db.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","storefront-optimizer")
    .eq("status","needs_attention").ilike("error","%ended without a recognizable status%");
  for(const j of (sf||[]) as any[]){
    await db.from("agent_jobs").update({status:"cancelled",needs_attention_class:null,
      log_tail:"Cancelled — outage-window fizzle (session ended without a parseable verdict). Not a code issue; storefront optimizer itself untouched."}).eq("id",j.id).eq("status","needs_attention");
    console.log(`✓ cancelled storefront fizzle ${j.id}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
