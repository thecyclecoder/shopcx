import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="media-buyer-digest-consolidate-product-names-suppress-noop";
(async()=>{
  const db=createAdminClient();
  // guard: no in-flight spec-test already
  const {data:inflight}=await db.from("agent_jobs").select("id").eq("workspace_id",WS).eq("spec_slug",SLUG)
    .eq("kind","spec-test").in("status",["queued","queued_resume","building","claimed"]).limit(1);
  if(inflight?.length){ console.log("already in-flight spec-test:",inflight[0].id); return; }
  const {data:ins,error}=await db.from("agent_jobs").insert({
    workspace_id:WS, spec_slug:SLUG, kind:"spec-test", status:"queued", created_by:null,
  }).select("id").single();
  if(error){ console.log("insert failed:",error.message); return; }
  console.log("✓ fresh spec-test enqueued:",(ins as any).id,"— re-verifies against human-free checks (should return approved, all-auto-pass).");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
