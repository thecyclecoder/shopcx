import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  const { data } = await db.from("agent_jobs")
    .select("id,kind,status,spec_slug,error,created_at,needs_attention_class")
    .eq("workspace_id",WS)
    .in("kind",["repair","coverage-register"])
    .in("status",["needs_attention","queued","claimed","building","needs_input","needs_approval","queued_resume"])
    .order("created_at",{ascending:false});
  console.log(`${(data||[]).length} live/parked repair+coverage jobs:\n`);
  for(const j of (data||[]) as any[]){
    console.log(`[${j.kind}] ${j.status} (${j.needs_attention_class||"-"}) slug=${j.spec_slug||"-"} age=${Math.round((Date.now()-new Date(j.created_at).getTime())/60000)}m`);
    console.log(`   id=${j.id}`);
    console.log(`   err: ${String(j.error||"").replace(/\n/g," ").slice(0,180)}\n`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
