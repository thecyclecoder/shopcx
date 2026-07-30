import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // builds past redrive cap (>=2 watchdog-redrive cancels + still needs_attention)
  const { data:na }=await admin.from("agent_jobs").select("spec_slug").eq("workspace_id",WS).eq("kind","build").eq("status","needs_attention");
  for(const j of na||[]){
    const { data:pr }=await admin.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",j.spec_slug).eq("status","cancelled").ilike("error","%watchdog-redrive%");
    if((pr||[]).length>=2) console.log(`PAST-CAP needs_attention build: ${j.spec_slug} (${(pr||[]).length} redrives)`);
  }
  // new approval types on build jobs (not migration/fork)
  const { data:app }=await admin.from("agent_jobs").select("spec_slug,pending_actions").eq("workspace_id",WS).eq("kind","build").in("status",["needs_approval","needs_input"]);
  for(const j of app||[]){
    for(const a of ((j.pending_actions as any[])||[])){
      if(a.status==="pending" && !["apply_migration","design_fork","design_decision"].includes(a.type))
        console.log(`NEW approval type on build ${j.spec_slug}: ${a.type} — ${String(a.summary||a.preview||"").slice(0,70)}`);
    }
  }
  // overall active build lane + mario
  const { data:act }=await admin.from("agent_jobs").select("kind,status").in("status",["queued","claimed","building","needs_attention","needs_approval"]);
  const c:Record<string,number>={}; for(const j of act||[]){ const k=`${j.kind}/${j.status}`; c[k]=(c[k]||0)+1; }
  console.log("active:", JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>/build|mario|spec-test/.test(k)))));
})().then(()=>process.exit(0));
