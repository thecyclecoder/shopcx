import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks, upsertPhaseChecks } from "../src/lib/spec-phase-checks-table";
import { investigateSpec } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TSC={position:1,description:"tsc --noEmit clean",kind:"auto" as const,exec_kind:"tsc",params:null};
(async()=>{
  for(const slug of ["media-buyer-kill-on-decision-tree-retire-roas-floor","register-media-buyer-test-cadence-monitored-loop","ready-to-test-exclude-archived-url-removed-creatives","remove-stale-max-watch-and-director-training-skill"]){
    const inv:any=await investigateSpec(WS,slug); const d=inv.diagnosis??inv;
    const s:any=await getSpec(WS,slug); if(!s){console.log(`${slug}: NOT FOUND`);continue;}
    let stripped=0;
    for(const p of (s.phases||[])){
      const checks=await listPhaseChecks(p.id);
      const humans=checks.filter((c:any)=>c.kind==="human"||c.exec_kind==="needs_human");
      if(!humans.length) continue;
      const auto=checks.filter((c:any)=>!(c.kind==="human"||c.exec_kind==="needs_human")).map((c:any,i:number)=>({position:i+1,description:c.description,kind:"auto" as const,exec_kind:c.exec_kind,params:c.params??null}));
      await upsertPhaseChecks(p.id,(auto.length?auto:[TSC]) as any); stripped+=humans.length;
    }
    console.log(`${slug} → status=${d.derivedStatus}, stripped ${stripped} human check(s)`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
