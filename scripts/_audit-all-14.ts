import { createAdminClient } from "./_bootstrap";
const MS=["86680e16-9727-4f5c-81aa-d291e2e7c9a1","f9fbcbd7-6919-43bd-9f24-a01bfe1bd731","081440b3-6631-4727-8dd0-ee61fbe9cf18","61e6f0c6-f7e8-48fb-a5a3-ce19b1650edf","a25be4d1-776d-4054-8d55-bb165f387c3f"];
async function main(){const a=createAdminClient();
  const {data:specs}=await a.from("specs").select("slug,parent,milestone_id,vale_pass,vale_review_passed_at")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("milestone_id",MS);
  const {data:diag}=await a.from("director_activity").select("spec_slug,reason,created_at")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").eq("action_kind","spec_review_needs_fix")
    .order("created_at",{ascending:false});
  const reasonBySlug=new Map<string,string>();
  for(const d of diag||[]) if(!reasonBySlug.has(d.spec_slug)) reasonBySlug.set(d.spec_slug, d.reason||"");
  console.log(`specs: ${(specs||[]).length}\n`);
  let bareGoal=0, passed=0, failed=0, unreviewed=0;
  for(const s of (specs||[]).sort((x,y)=>String(x.milestone_id).localeCompare(String(y.milestone_id)))){
    const anchored=/#/.test(s.parent||"");
    if(!anchored && /guaranteed-ticket-handling/.test(s.parent||"")) bareGoal++;
    const state = s.vale_pass===true?"PASS": s.vale_pass===false?"FAIL":"(unreviewed)";
    if(s.vale_pass===true)passed++; else if(s.vale_pass===false)failed++; else unreviewed++;
    console.log(`${state.padEnd(12)} anchored=${anchored?"Y":"N"}  ${s.slug.slice(0,48)}`);
    const r=reasonBySlug.get(s.slug);
    if(r){ // extract the DEFECT clause
      const m=r.match(/DEFECT[^;]*(;|$)/i)||r.match(/\(4\)[^;]*/)||[r.slice(0,200)];
      console.log(`     ↳ ${(m[0]||'').replace(/\s+/g,' ').slice(0,200)}`);
    }
  }
  console.log(`\nsummary: PASS=${passed} FAIL=${failed} unreviewed=${unreviewed} · bare-goal-parent=${bareGoal}/14`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
