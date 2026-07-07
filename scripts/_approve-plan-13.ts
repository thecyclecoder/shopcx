import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
const JOB="1e199bbb-151c-4122-811e-b72409b4c3c2";
async function main(){
  const a=createAdminClient();
  const {data:job}=await a.from("agent_jobs").select("pending_actions").eq("id",JOB).maybeSingle();
  const ids=((job?.pending_actions as any[])||[]).filter(x=>x.status==="pending").map(x=>x.id);
  console.log(`approving ${ids.length} pending actions...`);
  for(const actionId of ids){
    const r=await approveRoadmapAction(WS,OWNER,{jobId:JOB,actionId,decision:"approve",source:"web"});
    console.log(`  ${actionId}: ${r.ok?"approved":"FAIL "+((r as any).error)}`);
    if(!r.ok) { console.log("  stopping on failure"); break; }
  }
  const {data:after}=await a.from("agent_jobs").select("status,pending_actions").eq("id",JOB).maybeSingle();
  const pa=(after?.pending_actions as any[])||[];
  console.log(`\njob status now: ${after?.status}`);
  console.log(`action statuses: ${pa.map(x=>x.status).join(", ")}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
