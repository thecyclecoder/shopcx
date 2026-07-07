import { loadEnv } from "./_bootstrap";
loadEnv();
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
async function main(){
  const r=await enqueueBuildIfDue(WS,"playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks",{createdBy:OWNER});
  console.log("re-enqueue playbook-compiler:", r.enqueued?("✅ ENQUEUED job "+r.jobId):("— skip reason="+r.reason));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
