import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:j }=await admin.from("agent_jobs").select("id,spec_slug,pending_actions")
    .eq("kind","build").eq("status","needs_approval").eq("spec_slug","bianca-cold-scaler-campaign-cac-ltv-sensor").maybeSingle();
  console.log("bianca job_id:", j?.id, "action:", JSON.stringify((j?.pending_actions as any)?.[0]?.id));
  // Dahlia trigger: MONITORED_LOOPS / crons mentioning ad-creative or dahlia
  const { data:sw }=await admin.from("kill_switches").select("key,enabled").limit(500);
  const creativeish=(sw||[]).filter(s=>/creativ|dahlia|ad-?creat|arming/i.test(s.key));
  console.log("switches mentioning creative/arming:", JSON.stringify(creativeish));
  // arming authorizations
  const { data:arm }=await admin.from("media_buyer_arming_authorization").select("*").limit(5).then((r:any)=>r).catch(()=>({data:null}));
  console.log("arming rows:", arm? JSON.stringify(arm).slice(0,300):"(no table/err)");
})().then(()=>process.exit(0));
