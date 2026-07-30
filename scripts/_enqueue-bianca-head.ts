import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="bianca-route-ready-creatives-by-dahlia-temperature-tag";
(async()=>{
  const s:any=await getSpec(WS,SLUG);
  console.log("status:", s?.status, "| deferred:", s?.deferred, "| auto_build:", s?.auto_build, "| blocked_by:", JSON.stringify(s?.blocked_by));
  console.log("phases:", (s?.phases||[]).map((p:any)=>`P${p.position}:${p.status}`).join(" "));
  const r=await enqueueBuildIfDue(WS, SLUG, {createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
  console.log("enqueue result:", JSON.stringify(r));
})().then(()=>process.exit(0));
