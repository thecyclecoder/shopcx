import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="competitor-sdk-chokepoint-and-per-product-cleanup";
(async()=>{
  const db=createAdminClient();
  // Find the parked build job for this spec
  const { data:jobs } = await db.from("agent_jobs")
    .select("id,status,needs_attention_class,spec_slug")
    .eq("workspace_id",WS).eq("kind","build").eq("spec_slug",SLUG)
    .in("status",["needs_attention"]);
  if(!jobs?.length){ console.log("no parked build job found (maybe already redriven)"); return; }
  for(const j of jobs as any[]){
    const { error } = await db.from("agent_jobs").update({
      status:"queued",
      needs_attention_class:null,
      error:null,
      log_tail:"Manual redrive — package.json reconcile conflict resolved by hand (merged origin/main into the branch, kept both check:competitors-sdk-compliance + check:no-markdown-spec-authoring in predeploy) and pushed. Branch now contains main; reconcile will pass.",
    }).eq("id",j.id).eq("status","needs_attention");
    console.log(error ? `FAILED ${j.id}: ${error.message}` : `✓ redriven ${j.id} (${j.needs_attention_class}) → queued`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
