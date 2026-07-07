import "./_bootstrap";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
const JOB="5ec364c3-2a64-48fe-96d7-2d98090e858d", ACTION="amra0lklo0";
async function main(){
  const r=await approveRoadmapAction(WS,OWNER,{jobId:JOB,actionId:ACTION,decision:"approve",source:"web"});
  console.log("approve clarified check-widen migration:", r.ok?"✅ approved → build resumes":"FAIL "+((r as any).error));
  if(r.ok) console.log("  job status now:", (r as any).job?.status);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
