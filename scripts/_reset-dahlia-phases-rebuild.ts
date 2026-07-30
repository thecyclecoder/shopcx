import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { stampPhaseBuilt, getSpec } from "../src/lib/specs-table";
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-copy-author-box-session";
(async()=>{
  const a=createAdminClient();
  // 1. clear build_sha on P1/P2 (their code lived on the deleted branch; never merged → reset to planned)
  await stampPhaseBuilt(WS, SLUG, 1, { build_sha: null });
  await stampPhaseBuilt(WS, SLUG, 2, { build_sha: null });
  console.log("cleared build_sha on P1, P2");
  // 2. cancel the needs_input build scoped wrongly to P3
  const { data:active }=await a.from("agent_jobs").select("id,status").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",SLUG).in("status",["needs_input","needs_approval","queued_resume","queued","claimed","building"]);
  for(const j of active||[]){
    await a.from("agent_jobs").update({status:"cancelled", error:"rebuild-from-P1 (CEO 2026-07-16): P1/P2 build_sha cleared (deleted stale branch); re-driving whole spec from Phase 1 on the unified goal branch.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",(j as any).id);
    console.log("cancelled", (j as any).id.slice(0,8), (j as any).status);
  }
  // 3. verify phases now planned
  const s:any=await getSpec(WS, SLUG);
  console.log("phases now:", (s?.phases||[]).map((p:any)=>`P${p.position}:${p.status}`).join(" "));
  // 4. fresh build → scopes to P1
  const r=await enqueueBuildIfDue(WS, SLUG, {createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
  console.log("enqueue:", JSON.stringify(r));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
