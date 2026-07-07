import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main(){const a=createAdminClient();
  for(let i=0;i<30;i++){
    const {data:job}=await a.from("agent_jobs").select("status").eq("id","1e199bbb-151c-4122-811e-b72409b4c3c2").maybeSingle();
    const {data:specs}=await a.from("specs").select("slug,status,auto_build")
      .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
    const n=(specs||[]).length;
    if(n>=14 || (job?.status!=="building" && job?.status!=="queued_resume" && job?.status!=="claimed")){
      console.log(`DONE — job=${job?.status}, specs under goal=${n}`);
      const ab=(specs||[]).map(s=>s.auto_build);
      console.log(`auto_build values: ${JSON.stringify([...new Set(ab)])}`);
      console.log(`status values: ${JSON.stringify([...new Set((specs||[]).map(s=>s.status))])}`);
      for(const s of (specs||[]).sort((x,y)=>x.slug.localeCompare(y.slug))) console.log(`  ab=${String(s.auto_build).padEnd(5)} st=${String(s.status).padEnd(9)} ${s.slug.slice(0,52)}`);
      return;
    }
    await sleep(12000);
  }
  console.log("timed out waiting for Pia's authoring pass");
}
main().catch(e=>{console.error(e.message);process.exit(1);});
