import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,parent,vale_pass").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
  let anchored=0,bare=0;
  for(const s of data||[]){ const ok=(s.parent||"").includes("milestone"); if(ok)anchored++; else {bare++; console.log("STILL BARE:",s.slug,"::",s.parent);} }
  console.log(`anchored=${anchored}/14  bare=${bare}`);
  console.log(`vale_pass states: ${JSON.stringify((data||[]).reduce((m:any,s)=>{const k=String(s.vale_pass);m[k]=(m[k]||0)+1;return m;},{}))}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
