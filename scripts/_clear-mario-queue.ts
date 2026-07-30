import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const admin=createAdminClient();
  const { data:q }=await admin.from("agent_jobs").select("id").eq("kind","mario").eq("status","queued");
  const ids=(q||[]).map(r=>r.id);
  console.log("queued mario jobs to cancel:", ids.length);
  if(ids.length){
    const { error, count }=await admin.from("agent_jobs")
      .update({status:"cancelled", error:"911 (ceo:dylan 2026-07-16): Mario mass-enqueued fix jobs across all specs incl. archived/shipped ones after a visibility increase; cleared pending hotfix that excludes terminal specs from the stall scan.", questions:[], pending_actions:[], updated_at:new Date().toISOString()},{count:"exact"})
      .eq("kind","mario").eq("status","queued");
    console.log("cancelled:", count ?? "(ok)", error?("ERR "+error.message):"");
  }
  const { data:left }=await admin.from("agent_jobs").select("id,status,spec_slug").eq("kind","mario").in("status",["queued","claimed","building"]);
  console.log("remaining active mario:", JSON.stringify(left));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
