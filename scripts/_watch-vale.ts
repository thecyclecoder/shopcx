import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,vale_pass,ada_disposition,deferred,intended_status").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
  const fail=(data||[]).filter(s=>s.vale_pass===false);
  console.log(`vale_pass=false: ${fail.length}`); for(const s of fail) console.log(`  ${s.slug.slice(0,52)}`);
  const dispo=(data||[]).reduce((m:any,s)=>{const k=`vale=${s.vale_pass}/disp=${s.ada_disposition||'-'}/def=${s.deferred}`;m[k]=(m[k]||0)+1;return m;},{});
  console.log("state buckets:", JSON.stringify(dispo,null,0));
  // goal row: promotion held?
  const {data:g}=await a.from("goals").select("slug,status").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").eq("slug","guaranteed-ticket-handling").maybeSingle();
  console.log("goal status:", g?.status);
  const cols=await a.from("goals").select("*").eq("slug","guaranteed-ticket-handling").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").maybeSingle();
  const held=(cols.data as any)?.promotion_held_reason ?? (cols.data as any)?.promotionHeldReason;
  console.log("promotion_held_reason:", held ?? "(none)");
}
main().catch(e=>{console.error(e.message);process.exit(1);});
