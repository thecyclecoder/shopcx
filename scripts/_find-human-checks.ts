import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks } from "../src/lib/spec-phase-checks-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=[
  "media-buyer-digest-consolidate-product-names-suppress-noop",
  "competitor-sdk-chokepoint-and-per-product-cleanup",
  "register-media-buyer-test-cadence-monitored-loop",
  "ready-to-test-exclude-archived-url-removed-creatives",
  "media-buyer-kill-on-decision-tree-retire-roas-floor",
  "remove-stale-max-watch-and-director-training-skill",
];
(async()=>{
  for(const slug of SLUGS){
    const s:any = await getSpec(WS, slug);
    if(!s){console.log(`${slug}: NOT FOUND`);continue;}
    for(const p of (s.phases||[])){
      const checks = await listPhaseChecks(p.id);
      const humans = checks.filter((c:any)=>c.kind==="human"||c.exec_kind==="needs_human");
      if(humans.length){
        console.log(`\n${slug}\n  phase ${p.position} "${p.title}" id=${p.id}`);
        console.log(`    ${checks.length} checks; ${humans.length} HUMAN → ${humans.map((h:any)=>`[pos${h.position} ${h.exec_kind}] ${h.description?.slice(0,50)}`).join(" | ")}`);
      }
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
