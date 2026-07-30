import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-andromeda-concept-diversity-tags";
(async()=>{
  const a=createAdminClient();
  const s:any=await getSpec(WS,SLUG);
  console.log("status:", s.status, "| phases:", (s.phases||[]).map((p:any)=>`P${p.position}:${p.status}`).join(" "));
  // build jobs
  const { data:jobs }=await a.from("agent_jobs").select("id,status,needs_attention_class,error,updated_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",SLUG).order("updated_at",{ascending:false}).limit(3);
  console.log("\nbuild jobs:");
  for(const j of jobs||[]) console.log(`  ${(j as any).id.slice(0,8)} ${(j as any).status}${(j as any).needs_attention_class?"/"+(j as any).needs_attention_class:""}`);
  // spec_test_runs
  const { data:st }=await a.from("spec_test_runs").select("id,verdict,created_at,issues,summary").eq("workspace_id",WS).eq("spec_slug",SLUG).order("created_at",{ascending:false}).limit(3);
  console.log("\nspec_test_runs:", (st||[]).length);
  for(const r of st||[]){
    console.log(`\n  [${(r as any).verdict}] ${(r as any).created_at?.slice(0,16)}`);
    console.log("  summary:", ((r as any).summary||"").slice(0,300));
    const iss=(r as any).issues;
    if(iss) console.log("  issues:", JSON.stringify(iss).slice(0,600));
  }
})().then(()=>process.exit(0));
