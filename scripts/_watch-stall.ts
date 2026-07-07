import { createAdminClient } from "./_bootstrap";
const SIX=["confidence-gated-problem-lockin-and-selective-clarify","cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations","cs-director-storyline-digests-to-founder-with-bidirectional-reply","cs-director-third-rung-hard-calls-above-triage-quorum","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks"];
async function main(){const a=createAdminClient();
  console.log("=== any build jobs for the 6 unbuilt specs? ===");
  for(const slug of SIX){
    const {data}=await a.from("agent_jobs").select("status,created_at").eq("kind","build").eq("spec_slug",slug).order("created_at",{ascending:false}).limit(1);
    const j=(data||[])[0];
    console.log(`  ${slug.slice(0,44).padEnd(46)} ${j?j.status+' @'+new Date(j.created_at).toISOString().slice(11,16):'NO BUILD JOB'}`);
  }
  console.log("\n=== box liveness (most recent agent_jobs activity, any kind) ===");
  const {data:recent}=await a.from("agent_jobs").select("kind,status,updated_at").order("updated_at",{ascending:false}).limit(5);
  for(const j of recent||[]) console.log(`  ${new Date(j.updated_at).toISOString().slice(11,19)}  ${j.kind}\t${j.status}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
