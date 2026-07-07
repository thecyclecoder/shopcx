import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,vale_pass,ada_disposition").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
  const pass=(data||[]).filter(s=>s.vale_pass===true).length;
  const fail=(data||[]).filter(s=>s.vale_pass===false).length;
  const pend=(data||[]).filter(s=>s.vale_pass===null).length;
  console.log(`PASS=${pass} FAIL=${fail} PENDING=${pend}  (of 14)`);
  for(const s of data||[]) if(s.vale_pass!==true) console.log(`  ${s.vale_pass===false?"FAIL":"pending"}: ${s.slug.slice(0,52)}`);
  const disp=(data||[]).filter(s=>s.ada_disposition).length;
  console.log(`ada dispositioned: ${disp}/14`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
