import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("agent_jobs").select("id,kind,status,spec_slug").in("status",["needs_input","needs_approval"]).order("updated_at",{ascending:false}).limit(20);
  const g=(data||[]).filter(j=>["build"].includes(j.kind));
  if(!g.length) console.log("  none");
  for(const j of g) console.log(`  ${j.status}\t${j.kind}\t${(j.spec_slug||'').slice(0,50)}\t${j.id}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
