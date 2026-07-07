import { createAdminClient } from "./_bootstrap";
const TWO=["model-picker-routes-on-state-not-tags-ltv-stops-buying-opus","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks"];
async function main(){const a=createAdminClient();
  for(const slug of TWO){
    const {data}=await a.from("agent_jobs").select("id,status,created_at").eq("kind","build").eq("spec_slug",slug).in("status",["queued","claimed","building","needs_input","needs_approval","queued_resume"]).order("created_at",{ascending:false});
    console.log(`${slug.slice(0,44)}: ${(data||[]).length} active build job(s)`);
    for(const j of data||[]) console.log(`   ${j.status} @${new Date(j.created_at).toISOString().slice(11,19)} ${j.id.slice(0,8)}`);
  }
  // box liveness + what's building now
  const {data:building}=await a.from("agent_jobs").select("kind,spec_slug,status,updated_at").in("status",["building","claimed"]).order("updated_at",{ascending:false}).limit(6);
  console.log("\ncurrently building/claimed:");
  for(const j of building||[]) console.log(`   ${j.kind}\t${j.status}\t${(j.spec_slug||'').slice(0,40)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
