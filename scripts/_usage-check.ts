import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  // usage-wall signal
  const {data:blocked}=await a.from("agent_jobs").select("kind,spec_slug,status").eq("status","blocked_on_usage").limit(10);
  console.log(`blocked_on_usage jobs: ${(blocked||[]).length}`, (blocked||[]).map(j=>j.kind).join(","));
  // what has the box CLAIMED/BUILT (any lane) most recently — is anything progressing?
  const {data:live}=await a.from("agent_jobs").select("kind,status,updated_at").in("status",["claimed","building"]).order("updated_at",{ascending:false}).limit(8);
  console.log("currently claimed/building:", (live||[]).map(j=>`${j.kind}@${new Date(j.updated_at).toISOString().slice(11,16)}`).join(" "));
  // build-lane specifically: last time ANY build was claimed/building
  const {data:lastbuild}=await a.from("agent_jobs").select("status,updated_at,claimed_at").eq("kind","build").not("claimed_at","is",null).order("claimed_at",{ascending:false}).limit(3);
  console.log("last build CLAIMS:", (lastbuild||[]).map(j=>`${j.status}@claimed ${new Date(j.claimed_at).toISOString().slice(11,16)}`).join(" · "));
}
main().catch(e=>{console.error(e.message);process.exit(1);});
