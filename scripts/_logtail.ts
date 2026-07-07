import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("agent_jobs").select("spec_slug,status,log_tail,session_note,error,reap_count,updated_at").eq("kind","build").eq("spec_slug","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus").order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(!data){console.log("no job");return;}
  console.log("status:",data.status,"reap:",data.reap_count,"err:",data.error||"-","note:",data.session_note||"-");
  console.log("log_tail (last 900 chars):");
  console.log(String(data.log_tail||"(empty)").slice(-900));
}
main().catch(e=>{console.error(e.message);process.exit(1);});
