import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  for(const slug of ["media-buyer-replenish-per-product-scope","media-buyer-kill-on-decision-tree-retire-roas-floor"]){
    const s:any = await getSpec(WS, slug);
    console.log(`${slug}:`);
    console.log(`   derived status: ${s?.status ?? s?.derivedStatus ?? "?"}  owner: ${s?.owner}  parent_ref: ${s?.parent_ref ?? s?.parentRef}  phases: ${s?.phases?.length ?? "?"}  auto_build: ${s?.auto_build ?? s?.autoBuild}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
