import { createAdminClient } from "./_bootstrap";
const SLUGS=["orchestrator-handler-alias-catalog-for-no-handler-misses","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("*")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("slug",SLUGS);
  for(const s of data||[]){
    console.log("\n════════", s.slug);
    // print any review/vale/flags fields
    for(const k of Object.keys(s)){
      if(/vale|review|flag|reason|verdict|diagnos|fix|quality/i.test(k)){
        console.log(`  ${k}:`, JSON.stringify((s as any)[k]));
      }
    }
  }
  console.log("\n(all spec columns:", Object.keys((data||[])[0]||{}).join(", "),")");
}
main().catch(e=>{console.error(e.message);process.exit(1);});
