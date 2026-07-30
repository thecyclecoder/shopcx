import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/3.6e6).toFixed(1)}h`:"—";
(async()=>{
  const admin=createAdminClient();
  // any active build jobs across Dahlia+Bianca members (the serializer's blockers)
  const { data } = await admin.from("agent_jobs").select("spec_slug,status,updated_at").eq("workspace_id",WS).eq("kind","build")
    .in("status",["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage"])
    .order("updated_at",{ascending:false});
  console.log("active build jobs (serializer's in-flight set):");
  for(const j of data||[]) console.log(`  [${j.status}] ${j.spec_slug} ${ago(j.updated_at)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
