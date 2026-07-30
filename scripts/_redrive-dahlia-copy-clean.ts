import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-copy-author-box-session";
(async()=>{
  const a=createAdminClient();
  // cancel the stuck builds (stale branch now deleted; they can't reconcile)
  const { data:stuck }=await a.from("agent_jobs").select("id,status").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",SLUG).in("status",["needs_attention","needs_approval","queued_resume","queued","claimed","building"]);
  for(const j of stuck||[]){
    await a.from("agent_jobs").update({status:"cancelled", error:"goal-branch-unify redrive (CEO 2026-07-16): stale build branch deleted; re-driving fresh off the unified goal branch (main pack + siblings). Superseded.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",(j as any).id);
    console.log("cancelled stuck build", (j as any).id.slice(0,8), (j as any).status);
  }
  // fresh build — branches clean off the now-unified goal branch
  const r=await enqueueBuildIfDue(WS, SLUG, {createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
  console.log("enqueue:", JSON.stringify(r));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
