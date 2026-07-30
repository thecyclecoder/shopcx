import { loadEnv } from "./_bootstrap"; loadEnv();
import { whyIsSpecNotBuilding, whatIsSpecWaitingOn } from "../src/lib/spec-investigation";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  console.log("why:", JSON.stringify(await whyIsSpecNotBuilding(WS,"dahlia-produces-3-placement-multi-copy-creative-pack")));
  const admin=createAdminClient();
  const { data:recent }=await admin.from("agent_jobs").select("spec_slug,status,claimed_at").eq("kind","build").not("claimed_at","is",null).order("claimed_at",{ascending:false}).limit(5);
  console.log("recent claimed builds:");
  for(const j of recent||[]) console.log(`  ${j.status.padEnd(15)} ${j.spec_slug} claimed=${j.claimed_at}`);
})().then(()=>process.exit(0));
