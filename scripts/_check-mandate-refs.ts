import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for(const slug of ["bianca-cold-scaler-campaign-cac-ltv-sensor","dahlia-deeper-competitor-selection","orders-classification-sdk"]){
    const s:any=await getSpec(WS, slug).catch(()=>null);
    if(s) console.log(`${slug}\n   parent_kind=${s.parent_kind} parent_ref=${s.parent_ref}\n   parent=${String(s.parent||"").slice(0,120)}`);
  }
})().then(()=>process.exit(0));
