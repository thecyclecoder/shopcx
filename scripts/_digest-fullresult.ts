import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data } = await admin.from("spec_test_runs").select("run_at,status,verdict,spec_branch,result")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-digest-consolidate-product-names-suppress-noop")
    .order("run_at",{ascending:false}).limit(1);
  const r:any=(data||[])[0];
  console.log(`latest run ${r?.run_at?.slice(0,19)} status=${r?.status} verdict=${r?.verdict} branch=${r?.spec_branch||"main"}`);
  for(const c of (r?.result||[])){
    console.log(`\n  [${c.verdict}] ${(c.text||"").slice(0,70)}`);
    if(c.verdict!=="pass") console.log(`     EVIDENCE: ${String(c.evidence||c.reason||"").slice(0,400)}`);
  }
  // also: is there an open agent_job for the mock-fix spec (why in_progress)?
  const { data: jobs } = await admin.from("agent_jobs").select("kind,status,spec_slug,created_at,error")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-agent-test-mock-support-neq-filter").order("created_at",{ascending:false}).limit(4);
  console.log("\n=== mock-fix agent_jobs ===");
  for(const j of (jobs||[]) as any[]) console.log(`  ${j.kind} ${j.status} ${j.created_at?.slice(0,19)} ${j.error?('ERR '+String(j.error).slice(0,100)):''}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
