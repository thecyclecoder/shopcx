import { loadEnv } from "./_bootstrap"; loadEnv();
import { inngest } from "../src/lib/inngest/client";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  await inngest.send({ name:"ads/creative-scout.sweep", data:{ workspaceId:WS, force:true } });
  console.log("fired ads/creative-scout.sweep { workspaceId, force:true } — forced image-only re-sweep of all competitors (~4 min, ~32 searches)");
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
