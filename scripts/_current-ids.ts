import { createAdminClient } from "./_bootstrap";
const TWO=["model-picker-routes-on-state-not-tags-ltv-stops-buying-opus","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks"];
async function main(){const a=createAdminClient();
  for(const slug of TWO){
    const {data}=await a.from("agent_jobs").select("id,status,created_at").eq("kind","build").eq("spec_slug",slug).in("status",["queued","claimed","building","queued_resume","needs_input","needs_approval"]).order("created_at",{ascending:false});
    console.log(`${slug.slice(0,30)}: ${(data||[]).length} active`);
    for(const j of data||[]) console.log(`   ${j.status}  ${j.id}  created=${new Date(j.created_at).toISOString().slice(11,19)}`);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
