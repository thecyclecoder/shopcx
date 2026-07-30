import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs").select("id,spec_slug,instructions,created_at")
    .eq("kind","mario").eq("status","queued").order("created_at",{ascending:false});
  const all=jobs||[];
  const bySource:Record<string,number>={};
  const sample:Record<string,string>={};
  for(const j of all){
    let fe="(no from_event)";
    try{ const b=JSON.parse(j.instructions||"{}"); fe=b.from_event||b.source||"(none)"; }catch{}
    bySource[fe]=(bySource[fe]||0)+1;
    if(!sample[fe]) sample[fe]=j.spec_slug||"-";
  }
  console.log("queued mario:", all.length, "| newest:", all[0]?.created_at);
  console.log("=== by from_event/source ===");
  for(const [s,n] of Object.entries(bySource)) console.log(`  ${s.padEnd(30)} ${n}   e.g. ${sample[s]}`);
  // clear
  const ids=all.map(j=>j.id);
  if(ids.length){
    await admin.from("agent_jobs").update({status:"cancelled", error:"911 clear (ceo:dylan 2026-07-16): Mario mass-enqueued on archived specs again; capturing source before the real fix.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("kind","mario").eq("status","queued");
  }
  console.log("\ncleared:", ids.length);
})().then(()=>process.exit(0));
