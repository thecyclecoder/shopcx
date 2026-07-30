import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="control-tower-suppress-box-cron-freshness-during-worker-outa";
(async()=>{
  const a=createAdminClient();
  const { data:stuck }=await a.from("agent_jobs").select("id,status").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",SLUG).in("status",["needs_attention","needs_approval","queued","claimed","building","queued_resume","needs_input"]);
  for(const j of stuck||[]){
    await a.from("agent_jobs").update({status:"cancelled", error:"stale-branch reconcile loop (CEO 2026-07-16): deleted the stale build branch; re-driving fresh off current main.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",(j as any).id);
    console.log("cancelled", (j as any).id.slice(0,8), (j as any).status);
  }
  const r=await enqueueBuildIfDue(WS,SLUG,{createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
  console.log("enqueue:", JSON.stringify(r));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
