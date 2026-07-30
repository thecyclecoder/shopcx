import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s:any = await getSpec(WS, "ad-creative-requires-real-packshot-never-invent-packaging");
  console.log(`owner=${s?.owner}\nparent_kind=${s?.parent_kind}\nparent_ref=${s?.parent_ref}\nparent=${JSON.stringify(s?.parent)}\nmilestone_id=${s?.milestone_id}\nauto_build=${s?.auto_build}\npriority=${s?.priority}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
