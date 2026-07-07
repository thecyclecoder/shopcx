import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data:now}=await a.rpc("now").then((r:any)=>r).catch(()=>({data:null}));
  const {data:specs}=await a.from("specs").select("slug,updated_at,vale_pass").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
  const {data:jobs}=await a.from("agent_jobs").select("spec_slug,status,created_at,updated_at").eq("kind","spec-review").order("created_at",{ascending:false}).limit(60);
  const latestJob=new Map<string,any>();
  for(const j of jobs||[]) if(j.spec_slug && !latestJob.has(j.spec_slug)) latestJob.set(j.spec_slug,j);
  console.log("slug".padEnd(50),"specUpd","      latestReviewJob(status@created)  review>fix?");
  for(const s of specs||[]){
    const j=latestJob.get(s.slug);
    const su=new Date(s.updated_at).getTime();
    const jc=j?new Date(j.created_at).getTime():0;
    const reviewAfterFix = jc>su;
    console.log(`${s.slug.slice(0,48).padEnd(50)} ${new Date(s.updated_at).toISOString().slice(11,19)}  ${j?j.status.padEnd(10)+" @"+new Date(j.created_at).toISOString().slice(11,19):"none".padEnd(20)}  ${reviewAfterFix?"REVIEW-AFTER-FIX":"fix-after-review(pending)"}`);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
