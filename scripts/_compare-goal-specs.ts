import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,status,auto_build,owner,milestone_id")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS)
    .order("milestone_id");
  console.log(`specs under the goal's milestones: ${(data||[]).length}`);
  for(const s of data||[]) console.log(`  status=${String(s.status).padEnd(9)} auto_build=${String(s.auto_build).padEnd(5)} ${s.slug.slice(0,54)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
