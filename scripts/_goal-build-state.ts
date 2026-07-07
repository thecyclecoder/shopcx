import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data:specs}=await a.from("specs").select("slug,status,merged_pr,last_merge_sha,ada_disposition,vale_pass").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
  const {data:builds}=await a.from("agent_jobs").select("spec_slug,status,pr_number,updated_at").eq("kind","build").order("updated_at",{ascending:false}).limit(60);
  const latest=new Map<string,any>();
  for(const j of builds||[]) if(j.spec_slug && !latest.has(j.spec_slug)) latest.set(j.spec_slug,j);
  for(const s of (specs||[]).sort((x,y)=>x.slug.localeCompare(y.slug))){
    const j=latest.get(s.slug);
    console.log(`${s.slug.slice(0,46).padEnd(48)} merged_pr=${s.merged_pr||'-'} status=${s.status||'?'} vale=${s.vale_pass} build=${j?j.status+(j.pr_number?'#'+j.pr_number:''):'none'}`);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
