import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data } = await admin.from("spec_test_runs").select("run_at,verdict,status,spec_branch,result")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-agent-test-mock-support-neq-filter").order("run_at",{ascending:false}).limit(3);
  console.log("runs:", data?.length||0);
  for(const r of (data||[]) as any[]){
    const res=(r.result||[]);
    const fails=res.filter((x:any)=>x.verdict&&x.verdict!=="pass");
    console.log(`\nrun ${r.run_at?.slice(0,19)} branch=${r.spec_branch||"main"} status=${r.status||r.verdict}`);
    for(const f of fails) console.log(`  ✗ ${(f.text||"").slice(0,55)} — ${String(f.evidence||f.reason||"").slice(0,200)}`);
    if(!fails.length && res.length) console.log(`  (all ${res.length} checks pass in this run)`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
