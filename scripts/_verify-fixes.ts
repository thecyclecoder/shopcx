import { createAdminClient } from "./_bootstrap";
const SLUGS=["orchestrator-handler-alias-catalog-for-no-handler-misses","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,parent,blocked_by,milestone_id,vale_pass,vale_review_passed_at,updated_at")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("slug",SLUGS);
  for(const s of data||[]){
    console.log("\n════", s.slug);
    console.log("  vale_pass:", s.vale_pass, " (null/false = will be re-reviewed)");
    console.log("  blocked_by:", JSON.stringify(s.blocked_by));
    console.log("  parent:", s.parent);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
