import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s:any = await getSpec(WS, "bianca-cold-test-recent-purchaser-exclusion");
  for (const p of s.phases||[]){
    console.log(`\n########## POSITION ${p.position} ##########`);
    console.log(`TITLE: ${p.title}`);
    console.log(`STATUS: ${p.status}`);
    console.log(`BODY:\n${p.body}`);
    console.log(`WHY:\n${p.why}`);
    console.log(`WHAT:\n${p.what}`);
    console.log(`VERIFICATION:\n${p.verification}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
