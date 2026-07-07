import { loadEnv } from "./_bootstrap";
loadEnv();
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
const SIX=["confidence-gated-problem-lockin-and-selective-clarify","cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations","cs-director-storyline-digests-to-founder-with-bidirectional-reply","cs-director-third-rung-hard-calls-above-triage-quorum","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks"];
async function main(){
  for(const slug of SIX){
    try{
      const r=await enqueueBuildIfDue(WS,slug,{createdBy:OWNER});
      console.log(`  ${r.enqueued?"✅ ENQUEUED":"— skip"}  ${slug.slice(0,44).padEnd(46)} ${r.enqueued?('job '+r.jobId):('reason='+r.reason)}`);
    }catch(e){console.log(`  ERROR ${slug.slice(0,40)}: ${e instanceof Error?e.message:e}`);}
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
