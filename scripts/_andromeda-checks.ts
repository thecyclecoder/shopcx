import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-andromeda-concept-diversity-tags";
(async()=>{
  const a=createAdminClient();
  const { data:st }=await a.from("spec_test_runs").select("agent_verdict,checks,created_at,agent_job_id").eq("spec_slug",SLUG).order("created_at",{ascending:false}).limit(1);
  const r:any=(st||[])[0];
  console.log("agent_verdict:", r?.agent_verdict, "| run:", r?.created_at?.slice(0,16));
  const checks=r?.checks||[];
  const fails=(Array.isArray(checks)?checks:[]).filter((c:any)=>c.status==="fail"||c.result==="fail"||c.verdict==="fail"||c.outcome==="auto_fail"||c.pass===false);
  console.log("\nFAILING checks:", fails.length);
  for(const c of fails){
    console.log("\n  •", (c.name||c.title||c.check||c.id||"?"));
    console.log("    reason:", (c.reason||c.detail||c.message||c.why||c.evidence||JSON.stringify(c)).toString().slice(0,400));
  }
  if(!fails.length && checks.length){ console.log("\n(couldn't match fail flag — dumping first check shape:)"); console.log(JSON.stringify(checks[0]).slice(0,500)); }
})().then(()=>process.exit(0));
