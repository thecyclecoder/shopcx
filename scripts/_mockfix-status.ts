import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  for(const slug of ["media-buyer-agent-test-mock-support-neq-filter","media-buyer-digest-consolidate-product-names-suppress-noop"]){
    const s:any=await getSpec(WS,slug).catch(()=>null);
    console.log(`${slug}: status=${s?.status??"(derived)"} phases=${(s?.phases||[]).map((p:any)=>p.status).join(",")}`);
  }
  // latest spec_test_run verdict for mock-fix
  const { data } = await admin.from("spec_test_runs").select("run_at,verdict,status,spec_branch,result")
    .eq("workspace_id",WS).eq("spec_slug","media-buyer-agent-test-mock-support-neq-filter").order("run_at",{ascending:false}).limit(2);
  for(const r of (data||[]) as any[]){
    const fails=(r.result||[]).filter((x:any)=>x.verdict!=="pass");
    console.log(`\n  run ${r.run_at?.slice(0,19)} branch=${r.spec_branch||"main"}: ${fails.length} failing`);
    for(const f of fails) console.log(`    ✗ ${f.text?.slice(0,60)} — ${String(f.evidence||"").slice(0,180)}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
