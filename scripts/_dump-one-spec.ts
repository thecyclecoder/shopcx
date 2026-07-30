import { loadEnv } from "./_bootstrap";
loadEnv();
import { listSpecs, getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const specs = await listSpecs(WS);
  const s:any = specs.find((x:any)=>x.slug==="dahlia-copy-author-box-session");
  console.log("listSpecs row keys:", Object.keys(s||{}).join(", "));
  console.log("listSpecs row:", JSON.stringify(s,null,2).slice(0,1200));
  const full:any = await getSpec(WS, "dahlia-copy-author-box-session");
  console.log("\ngetSpec keys:", Object.keys(full||{}).join(", "));
  if (full?.phases) console.log("phases:", JSON.stringify(full.phases?.map((p:any)=>({name:p.name??p.title,status:p.status})) ));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
