import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const admin=createAdminClient();
  // inspect the current queued batch BEFORE clearing: created_at spread (fresh burst?) + a couple slugs
  const { data:pre }=await admin.from("agent_jobs").select("spec_slug,created_at").eq("kind","mario").eq("status","queued").order("created_at",{ascending:false}).limit(50);
  const times=(pre||[]).map(r=>r.created_at).sort();
  console.log("queued mario:", (pre||[]).length, "| newest:", times[times.length-1], "| oldest:", times[0]);
  // clear
  const { data:q }=await admin.from("agent_jobs").select("id").eq("kind","mario").eq("status","queued");
  const ids=(q||[]).map(r=>r.id);
  if(ids.length){
    await admin.from("agent_jobs").update({status:"cancelled", error:"911 re-clear post-restart (ceo:dylan 2026-07-16): waiting on Vercel deploy of mario-skip-shipped-specs (#1911) to stop the shipped-spec re-enqueue.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("kind","mario").eq("status","queued");
  }
  console.log("cancelled:", ids.length);
  const { data:left }=await admin.from("agent_jobs").select("id,status,spec_slug").eq("kind","mario").in("status",["queued","claimed","building"]);
  console.log("remaining active mario:", JSON.stringify(left));
})().then(()=>process.exit(0));
