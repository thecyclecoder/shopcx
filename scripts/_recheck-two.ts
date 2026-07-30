import { loadEnv } from "./_bootstrap"; loadEnv();
import { investigateSpec } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for(const slug of ["media-buyer-digest-consolidate-product-names-suppress-noop","competitor-sdk-chokepoint-and-per-product-cleanup"]){
    const r:any = await investigateSpec(WS, slug); const d=r.diagnosis??r;
    console.log(`\n### ${slug}  → derivedStatus=${d.derivedStatus}`);
    for(const p of (d.phases||[])) console.log(`  P${p.index} ${p.status}  merge=${p.merge_sha?p.merge_sha.slice(0,8):"—"}`);
    for(const j of (d.jobs||[])) if(j.kind==="build"||j.needsAttentionClass) console.log(`  [${j.kind}] ${j.status} needsAttn=${j.needsAttentionClass} age=${j.ageMinutes}m ${j.error?("err:"+String(j.error).slice(0,90)):""}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
