import { loadEnv } from "./_bootstrap"; loadEnv();
import { whyIsSpecNotBuilding, whatIsSpecWaitingOn } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  console.log("why:", JSON.stringify(await whyIsSpecNotBuilding(WS,"dahlia-copy-author-box-session")));
  console.log("waiting:", JSON.stringify(await whatIsSpecWaitingOn(WS,"dahlia-copy-author-box-session")).slice(0,500));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
