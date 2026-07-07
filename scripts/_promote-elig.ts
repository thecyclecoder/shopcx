import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  for(const kind of ["spec-test","security-review"]){
    const {data}=await a.from("agent_jobs").select("status,updated_at").eq("kind",kind).eq("spec_slug","confidence-gated-problem-lockin-and-selective-clarify").order("updated_at",{ascending:false}).limit(1);
    const j=(data||[])[0];
    console.log(`  ${kind}: ${j?j.status+' @'+new Date(j.updated_at).toISOString().slice(11,16):'no job'}`);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
