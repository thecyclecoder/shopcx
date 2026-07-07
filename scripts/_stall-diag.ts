import { createAdminClient } from "./_bootstrap";
const TWO=["model-picker-routes-on-state-not-tags-ltv-stops-buying-opus","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks"];
async function main(){const a=createAdminClient();
  console.log("=== the 2 stuck build jobs (full state) ===");
  for(const slug of TWO){
    const {data}=await a.from("agent_jobs").select("id,status,created_at,updated_at,claimed_at,last_heartbeat_at,reap_count,error").eq("kind","build").eq("spec_slug",slug).order("created_at",{ascending:false}).limit(1);
    const j=(data||[])[0];
    if(j) console.log(`  ${slug.slice(0,38)}\n     status=${j.status} reap=${j.reap_count} claimed_at=${j.claimed_at?new Date(j.claimed_at).toISOString().slice(11,19):'-'} hb=${j.last_heartbeat_at?new Date(j.last_heartbeat_at).toISOString().slice(11,19):'-'} err=${j.error||'-'}`);
  }
  console.log("\n=== box activity across ALL kinds, last 45m (is the box alive + what lanes are busy) ===");
  const cut=new Date(Date.now()-45*60*1000).toISOString();
  const {data:recent}=await a.from("agent_jobs").select("kind,status,updated_at").gte("updated_at",cut).order("updated_at",{ascending:false}).limit(30);
  const byKind:Record<string,number>={};
  for(const j of recent||[]) byKind[`${j.kind}:${j.status}`]=(byKind[`${j.kind}:${j.status}`]||0)+1;
  console.log("  active/updated last 45m:", JSON.stringify(byKind));
  const anyBuildClaim=(recent||[]).some(j=>j.kind==='build'&&['claimed','building','completed'].includes(j.status));
  console.log("  any build claimed/built in last 45m:", anyBuildClaim);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
