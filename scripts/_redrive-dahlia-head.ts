import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", SLUG="dahlia-copy-author-box-session";
(async()=>{
  const admin=createAdminClient();
  // 1. supersede the 2 needs_attention build jobs (hot-file reconcile conflict on builder-worker.ts)
  const { data:stuck }=await admin.from("agent_jobs").select("id")
    .eq("workspace_id",WS).eq("spec_slug",SLUG).eq("kind","build").eq("status","needs_attention");
  for(const j of stuck||[]){
    await admin.from("agent_jobs").update({status:"cancelled", error:"redrive (ceo:dylan 2026-07-16): stale build branch hit a reconcile-with-main conflict on the hot file scripts/builder-worker.ts; superseded by a fresh build off current main.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",j.id);
  }
  console.log("superseded needs_attention builds:", (stuck||[]).length);
  // 2. fresh build
  const r=await enqueueBuildIfDue(WS, SLUG, {createdBy:null});
  console.log("enqueue fresh build:", JSON.stringify(r));
  const { data:now }=await admin.from("agent_jobs").select("id,status,kind").eq("workspace_id",WS).eq("spec_slug",SLUG).in("status",["queued","claimed","building"]);
  console.log("active jobs now:", JSON.stringify(now));
})().then(()=>process.exit(0));
