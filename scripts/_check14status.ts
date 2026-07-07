import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,status,owner,milestone_id,auto_build,intended_status_set_by")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906")
    .eq("slug","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus").maybeSingle();
  console.log(data);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
