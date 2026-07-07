import { createAdminClient, loadEnv } from "./_bootstrap";
loadEnv();
import { markSpecCardBackToReview } from "../src/lib/spec-card-state";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){
  const a=createAdminClient();
  const {data}=await a.from("specs").select("slug").eq("workspace_id",WS).in("milestone_id",MS);
  for(const s of data||[]){
    await markSpecCardBackToReview(WS,s.slug,{actor:"ceo:reauthor-parent-fix",reason:"parent re-anchored to milestone (bare-goal → milestone); clearing stale needs_fix verdict so Vale re-reviews the corrected spec"});
    console.log("  ↻ re-review:", s.slug.slice(0,52));
  }
  // confirm cleared
  const {data:after}=await a.from("specs").select("vale_pass,status").eq("workspace_id",WS).in("milestone_id",MS);
  const vp=(after||[]).reduce((m:any,s)=>{const k=String(s.vale_pass);m[k]=(m[k]||0)+1;return m;},{});
  console.log(`\nvale_pass after: ${JSON.stringify(vp)}  (null = queued for re-review)`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
