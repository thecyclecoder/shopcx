import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks } from "../src/lib/spec-phase-checks-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="media-buyer-agent-test-mock-support-neq-filter";
(async()=>{
  const s:any=await getSpec(WS,SLUG);
  for(const p of (s.phases||[])){
    const checks=await listPhaseChecks(p.id);
    console.log(`\nP${p.position} "${p.title}" id=${p.id}`);
    for(const c of checks as any[]) console.log(`   [pos${c.position}] kind=${c.kind} exec=${c.exec_kind} desc="${String(c.description).slice(0,80)}" params=${JSON.stringify(c.params)}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
