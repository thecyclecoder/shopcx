import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";
import { createAdminClient } from "./_bootstrap";
async function main(){
  const s=await getSpec("fdc11e10-b89f-4989-8b73-ed6526c4d906","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus");
  console.log("14th spec:", s?s.slug:"NOT FOUND");
  if(s){console.log(`  status=${s.status} owner=${s.owner} milestone_id=${(s as any).milestone_id} phases=${(s as any).phases?.length??'?'}`);}
  const a=createAdminClient();
  const {data:job}=await a.from("agent_jobs").select("status").eq("id","1e199bbb-151c-4122-811e-b72409b4c3c2").maybeSingle();
  console.log("plan job (13 specs):", job?.status);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
