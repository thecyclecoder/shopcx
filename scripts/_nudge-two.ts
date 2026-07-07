import { loadEnv } from "./_bootstrap";
loadEnv();
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
const TWO=["cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations","cs-director-storyline-digests-to-founder-with-bidirectional-reply"];
async function main(){
  for(const slug of TWO){
    const r=await enqueueBuildIfDue(WS,slug,{createdBy:OWNER});
    console.log(`  ${r.enqueued?"✅ ENQUEUED":"— skip"}  ${slug.slice(0,40).padEnd(42)} ${r.enqueued?('job '+r.jobId):('reason='+r.reason)}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
