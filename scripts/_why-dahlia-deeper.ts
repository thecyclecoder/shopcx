import { loadEnv } from "./_bootstrap"; loadEnv();
import { whyIsSpecNotBuilding } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const r=await whyIsSpecNotBuilding(WS, "dahlia-deeper-competitor-selection");
  console.log(JSON.stringify(r,null,2));
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
