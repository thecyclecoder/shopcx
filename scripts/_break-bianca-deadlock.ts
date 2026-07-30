/**
 * Break the Bianca goal-serializer deadlock: the queued build for
 * bianca-cold-test-recent-purchaser-exclusion holds the goal's admission slot (blocking
 * sibling enqueues) yet isn't claimable (not the earliest-ready member) → circular stall.
 * Cancel it so admission opens, then run the sanctioned goal reconciler to enqueue the true
 * earliest-ready member. The cancelled spec stays planned+eligible and re-enters naturally when
 * its turn comes. Founder-approved 2026-07-16 (kick the stuck builds). Dry unless APPLY=1.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { autoQueueUnblockedByGoal } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.env.APPLY==="1";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/60000).toFixed(0)}m`:"—";
(async()=>{
  const admin=createAdminClient();
  const { data:stuck } = await admin.from("agent_jobs").select("id,spec_slug,status,created_at")
    .eq("workspace_id",WS).eq("kind","build").eq("status","queued").eq("spec_slug","bianca-cold-test-recent-purchaser-exclusion");
  console.log(`deadlocked queued build(s): ${stuck?.length??0}`);
  for(const j of stuck||[]) console.log(`  ${j.id} queued ${ago(j.created_at)}`);
  if(!APPLY){ console.log("DRY RUN — APPLY=1 to break the deadlock."); return; }
  for(const j of stuck||[]){
    await admin.from("agent_jobs").update({status:"completed",error:"deadlock-break: cancelled to release goal admission; reconciler re-enqueues the earliest-ready Bianca member (this spec re-enters when its turn comes)",updated_at:new Date().toISOString()}).eq("id",j.id);
  }
  const q = await autoQueueUnblockedByGoal(WS,"bianca-temperature-aware-campaign-structure");
  console.log("bianca reconciler enqueued ->", JSON.stringify(q));
  const { data } = await admin.from("agent_jobs").select("spec_slug,status,updated_at").eq("workspace_id",WS).eq("kind","build")
    .in("status",["queued","claimed","building","queued_resume"]).order("updated_at",{ascending:false});
  console.log("\nactive build jobs now:"); for(const j of data||[]) console.log(`  [${j.status}] ${j.spec_slug} ${ago(j.updated_at)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
