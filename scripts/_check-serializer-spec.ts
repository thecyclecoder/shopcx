import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const s:any=await getSpec(WS,"goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock").catch((e:any)=>({err:e.message}));
  if(!s||s.err){ console.log("spec:", s?.err||"not found"); return; }
  console.log("status:", s.status, "| deferred:", s.deferred, "| auto_build:", s.auto_build);
  console.log("phases:", (s.phases||[]).map((p:any)=>`${p.position}:${p.status}`).join(" "));
})().then(()=>process.exit(0));
