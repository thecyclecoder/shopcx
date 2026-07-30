import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="sol-ticket-direction-artifact-and-first-touch-box-session";
(async()=>{
  const db=createAdminClient();
  const {data:jobs}=await db.from("agent_jobs").select("id,kind,status,branch,error,created_at,updated_at")
    .eq("workspace_id",WS).eq("spec_slug",SLUG).order("created_at",{ascending:false}).limit(6);
  console.log(`jobs for ${SLUG}:`);
  for(const j of (jobs||[]) as any[]) console.log(`  [${j.kind}] ${j.status} branch=${j.branch||"-"} age=${Math.round((Date.now()-new Date(j.created_at).getTime())/1440/60000)}d err=${String(j.error||"").slice(0,70)}`);
  const {data:s}=await db.from("specs").select("status,archived_at,updated_at").eq("workspace_id",WS).eq("slug",SLUG).maybeSingle();
  console.log("spec row:", JSON.stringify(s));
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
