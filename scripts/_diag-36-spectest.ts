import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
import { listPhaseChecks } from "../src/lib/spec-phase-checks-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="media-buyer-digest-consolidate-product-names-suppress-noop";
(async()=>{
  const db=createAdminClient();
  // latest spec-test job for this spec
  const {data:jobs}=await db.from("agent_jobs").select("id,status,error,log_tail,created_at,updated_at")
    .eq("workspace_id",WS).eq("kind","spec-test").eq("spec_slug",SLUG).order("created_at",{ascending:false}).limit(2);
  console.log("=== spec-test jobs ===");
  for(const j of (jobs||[]) as any[]){
    console.log(`\njob ${j.id} status=${j.status} created=${j.created_at}`);
    console.log("log_tail:\n"+String(j.log_tail||"").slice(0,1600));
  }
  // current phase checks (post-strip) — confirm no human left + list all
  console.log("\n\n=== CURRENT phase checks (post-strip) ===");
  const s:any=await getSpec(WS,SLUG);
  for(const p of (s.phases||[])){
    const checks=await listPhaseChecks(p.id);
    console.log(`P${p.position} "${p.title.slice(0,45)}": ${checks.map((c:any)=>`${c.exec_kind}${c.kind==="human"?"(HUMAN)":""}`).join(", ")}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
