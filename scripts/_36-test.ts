import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks } from "../src/lib/spec-phase-checks-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const slug="media-buyer-digest-consolidate-product-names-suppress-noop";
  // latest spec_test_run
  const { data: runs } = await admin.from("spec_test_runs").select("*")
    .eq("workspace_id",WS).eq("spec_slug",slug).order("run_at",{ascending:false}).limit(3);
  for(const r of (runs||[]) as any[]){
    console.log(`\n=== run ${r.run_at?.slice(0,19)} · verdict=${r.verdict??r.status} · branch=${r.spec_branch||"(main)"} ===`);
    const res=r.result||r.results||r.checks||r.report;
    if(res) console.log("  result:", JSON.stringify(res).slice(0,900));
    if(r.failing_checks) console.log("  failing_checks:", JSON.stringify(r.failing_checks).slice(0,600));
    if(r.summary) console.log("  summary:", String(r.summary).slice(0,400));
  }
  // per-phase checks + their pass/fail
  const s:any=await getSpec(WS,slug);
  console.log("\n=== phase checks ===");
  for(const p of (s?.phases||[])){
    const checks:any[]=await listPhaseChecks(p.id).catch(()=>[]);
    for(const c of checks){
      console.log(`  [${p.title?.slice(0,20)}] ${c.exec_kind} "${(c.description||c.text||'').slice(0,50)}" → ${c.last_status??c.status??'?'} ${c.last_error?('ERR:'+String(c.last_error).slice(0,120)):''}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
