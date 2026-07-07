import { createAdminClient, loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MS: Record<string,{n:string;title:string;anchor:string}> = {
  "86680e16-9727-4f5c-81aa-d291e2e7c9a1":{n:"M1",title:"Truthful actions",anchor:"#86680e16-truthful-actions"},
  "f9fbcbd7-6919-43bd-9f24-a01bfe1bd731":{n:"M2",title:"The resolution record (the spine)",anchor:"#f9fbcbd7-the-resolution-record"},
  "081440b3-6631-4727-8dd0-ee61fbe9cf18":{n:"M3",title:"Right-cost routing",anchor:"#081440b3-right-cost-routing"},
  "61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf":{n:"M4",title:"Capability + compiler loop",anchor:"#61e6f0c6-capability-and-compiler-loop"},
  "a25be4d1-776d-4054-8d55-bb165f387c3f":{n:"M5",title:"The autonomous CS Director",anchor:"#a25be4d1-autonomous-cs-director"},
};
async function main(){
  const a=createAdminClient();
  const {data:specs}=await a.from("specs").select("slug,parent,milestone_id")
    .eq("workspace_id",WS).in("milestone_id",Object.keys(MS));
  let fixed=0, skipped=0;
  for(const row of specs||[]){
    if((row.parent||"").includes("milestone")){ skipped++; continue; } // already anchored (my 2 fixes)
    const m=MS[row.milestone_id as string]; if(!m){console.log("no milestone map for",row.slug);continue;}
    const s:any=await getSpec(WS,row.slug);
    const input:any={
      title:s.title, why:s.why, what:s.what, summary:s.summary, owner:s.owner,
      parent:`[[../goals/guaranteed-ticket-handling${m.anchor}]] — ${m.n} "${m.title}" milestone.`,
      blocked_by:s.blocked_by||[],
      phases:(s.phases||[]).map((p:any)=>({title:p.title,why:p.why,what:p.what,body:p.body,verification:p.verification,status:"planned"})),
    };
    const ok=await authorSpecRowStructured(WS,row.slug,input,"planned",{intendedStatusSetBy:"ceo",milestoneId:row.milestone_id as string});
    console.log(`  ${ok?"✓":"FAIL"} ${m.n}  ${row.slug.slice(0,50)}`);
    if(ok)fixed++;
  }
  console.log(`\nre-anchored ${fixed} specs; skipped ${skipped} (already anchored).`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
