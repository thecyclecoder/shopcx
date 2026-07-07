import { createAdminClient } from "./_bootstrap";
const SLUGS=["orchestrator-handler-alias-catalog-for-no-handler-misses","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus"];
async function main(){const a=createAdminClient();
  const {data}=await a.from("director_activity").select("spec_slug,reason,metadata,created_at")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906")
    .eq("action_kind","spec_review_needs_fix").in("spec_slug",SLUGS)
    .order("created_at",{ascending:false});
  console.log(`rows: ${(data||[]).length}`);
  const seen=new Set();
  for(const r of data||[]){
    if(seen.has(r.spec_slug))continue; seen.add(r.spec_slug);
    console.log("\n════════", r.spec_slug);
    console.log("REASON:", r.reason);
    const d=(r.metadata as any)?.defects;
    if(Array.isArray(d)) d.forEach((x,i)=>console.log(`  defect ${i+1}: ${typeof x==='string'?x:JSON.stringify(x)}`));
    else if((r.metadata as any)) console.log("  metadata:", JSON.stringify(r.metadata).slice(0,800));
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
