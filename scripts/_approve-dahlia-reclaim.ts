import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:mem }=await a.from("workspace_members").select("user_id").eq("workspace_id",WS).limit(1).maybeSingle();
  const userId=(mem as any)?.user_id;
  if(!userId) throw new Error("no owner user id");
  const r=await approveRoadmapAction(WS, userId, {
    jobId:"ead0cac8-515b-4c41-9097-eec96599edc0",
    actionId:"mario-reclaim-1784231499045",
    decision:"approve",
    notes:"CEO-authorized (Dylan 2026-07-16): dahlia-copy-author-box-session build branch is stale against main's pack refactor (dahlia-produces-3-placement rewrote insertReadyCreative). Hand-merge would risk the actively-building 3-placement pack. Reclaim & re-drive rebuilds fresh off current main → clean branch → clean merge, re-authoring the copy-author feature on the current base.",
  });
  console.log("approved:", JSON.stringify(r));
})().then(()=>process.exit(0)).catch(e=>{console.error("APPROVE FAILED:",e.message);process.exit(1);});
