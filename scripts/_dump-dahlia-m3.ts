import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for(const slug of ["dahlia-temperature-banded-multi-variant-copy-pack","dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection"]){
    const s:any=await getSpec(WS,slug);
    console.log(`\n############ ${slug} ############`);
    console.log(`status=${s.status} blocked_by=${JSON.stringify(s.blocked_by)} milestone=${s.milestone_id}`);
    console.log(`WHY: ${s.why}`);
    console.log(`WHAT: ${s.what}`);
    console.log(`phases:`);
    for(const p of s.phases||[]) console.log(`  [${p.position}] ${p.title} (${p.status})\n     what: ${(p.what||"").slice(0,320)}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
