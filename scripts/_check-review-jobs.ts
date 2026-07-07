import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("agent_jobs").select("spec_slug,status,created_at,updated_at").eq("kind","spec-review")
    .order("created_at",{ascending:false}).limit(20);
  console.log("recent spec-review jobs:");
  for(const j of data||[]) console.log(`  ${j.status.padEnd(12)} ${new Date(j.created_at).toISOString().slice(11,19)}  ${(j.spec_slug||'').slice(0,48)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
