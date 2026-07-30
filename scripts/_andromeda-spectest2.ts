import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-andromeda-concept-diversity-tags";
(async()=>{
  const a=createAdminClient();
  // spec-test kind jobs
  const { data:stj }=await a.from("agent_jobs").select("id,status,error,updated_at").eq("workspace_id",WS).eq("kind","spec-test").eq("spec_slug",SLUG).order("updated_at",{ascending:false}).limit(4);
  console.log("spec-test jobs:", (stj||[]).length);
  for(const j of stj||[]) console.log(`  ${(j as any).id.slice(0,8)} ${(j as any).status} — ${((j as any).error||"").slice(0,120)}`);
  // director_activity loop-guard / spec_test escalations
  const { data:da }=await a.from("director_activity").select("action_kind,reason,metadata,created_at").eq("workspace_id",WS).eq("spec_slug",SLUG).order("created_at",{ascending:false}).limit(6);
  console.log("\ndirector_activity:", (da||[]).length);
  for(const r of da||[]) console.log(`  [${(r as any).action_kind}] ${((r as any).reason||"").slice(0,140)}`);
})().then(()=>process.exit(0));
