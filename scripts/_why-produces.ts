import { loadEnv } from "./_bootstrap"; loadEnv();
import { whyIsSpecNotBuilding } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for(const s of ["dahlia-produces-3-placement-multi-copy-creative-pack","dahlia-copy-author-box-session"]){
    console.log(s, "→", JSON.stringify(await whyIsSpecNotBuilding(WS,s)));
  }
})().then(()=>process.exit(0));
