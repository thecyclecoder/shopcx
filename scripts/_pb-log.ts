import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("agent_jobs").select("id,status,reap_count,claimed_at,last_heartbeat_at,error,session_note,log_tail,created_at,updated_at").eq("kind","build").eq("spec_slug","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks").order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(!data){console.log("no job");return;}
  console.log(`status=${data.status} reap=${data.reap_count} claimed=${data.claimed_at?new Date(data.claimed_at).toISOString().slice(11,19):'-'} hb=${data.last_heartbeat_at?new Date(data.last_heartbeat_at).toISOString().slice(11,19):'-'} created=${new Date(data.created_at).toISOString().slice(11,19)}`);
  console.log("error:", data.error||"-");
  console.log("session_note:", data.session_note||"-");
  console.log("log_tail (last 1200):"); console.log(String(data.log_tail||"(empty)").slice(-1200));
}
main().catch(e=>{console.error(e.message);process.exit(1);});
