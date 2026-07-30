import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks, upsertPhaseChecks } from "../src/lib/spec-phase-checks-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
// The two specs Dylan flagged. #36 is shipped-but-stuck; competitor is mid-build (strip pre-emptively).
const SLUGS=[
  "media-buyer-digest-consolidate-product-names-suppress-noop",
  "competitor-sdk-chokepoint-and-per-product-cleanup",
];
const TSC = { position:1, description:"tsc --noEmit clean", kind:"auto" as const, exec_kind:"tsc", params:null };
(async()=>{
  for(const slug of SLUGS){
    const s:any = await getSpec(WS, slug);
    if(!s){console.log(`${slug}: NOT FOUND`);continue;}
    for(const p of (s.phases||[])){
      const checks = await listPhaseChecks(p.id);
      const humans = checks.filter((c:any)=>c.kind==="human"||c.exec_kind==="needs_human");
      if(!humans.length) continue;
      const auto = checks.filter((c:any)=>!(c.kind==="human"||c.exec_kind==="needs_human"))
        .map((c:any,i:number)=>({position:i+1, description:c.description, kind:"auto" as const, exec_kind:c.exec_kind, params:c.params ?? null}));
      const next = auto.length ? auto : [TSC]; // never leave a phase with 0 checks
      await upsertPhaseChecks(p.id, next as any);
      console.log(`${slug} · phase ${p.position} "${p.title.slice(0,40)}" → removed ${humans.length} human, now ${next.length} auto (${next.map((c:any)=>c.exec_kind).join(",")})`);
    }
  }
  console.log("\nDONE stripping human checks.");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,500));process.exit(1);});
