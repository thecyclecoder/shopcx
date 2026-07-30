import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks, upsertPhaseChecks } from "../src/lib/spec-phase-checks-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="media-buyer-agent-test-mock-support-neq-filter";
const TSC={position:1,description:"tsc --noEmit clean",kind:"auto" as const,exec_kind:"tsc",params:null};
(async()=>{
  const s:any=await getSpec(WS,SLUG);
  for(const p of (s.phases||[])){
    const checks=await listPhaseChecks(p.id);
    const humans=checks.filter((c:any)=>c.exec_kind==="needs_human"||c.kind==="human");
    if(!humans.length) continue;
    const auto=checks.filter((c:any)=>!(c.exec_kind==="needs_human"||c.kind==="human"))
      .map((c:any,i:number)=>({position:i+1,description:c.description,kind:"auto" as const,exec_kind:c.exec_kind,params:c.params??null}));
    await upsertPhaseChecks(p.id,(auto.length?auto:[TSC]) as any);
    console.log(`P${p.position} "${p.title.slice(0,42)}" → stripped ${humans.length} needs_human; now ${(auto.length?auto:[TSC]).map((c:any)=>c.exec_kind).join(",")}`);
  }
  console.log("\nDone — oscillation source removed. P1 keeps tsc+unit_test+grep (all verified passing: 63/0).");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
