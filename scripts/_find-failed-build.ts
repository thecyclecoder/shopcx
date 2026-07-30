import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  // any build job for the sol slug (any status)
  const {data:b}=await db.from("agent_jobs").select("id,kind,status,spec_slug,error,created_at")
    .eq("workspace_id",WS).eq("kind","build").like("spec_slug","%sol-ticket-direction-artifact%").order("created_at",{ascending:false}).limit(5);
  console.log(`=== build jobs for sol-ticket-direction-artifact (${(b||[]).length}) ===`);
  for(const r of (b||[]) as any[]) console.log(`  ${r.id} ${r.status} err=${String(r.error||"").slice(0,80)} age=${Math.round((Date.now()-new Date(r.created_at).getTime())/86400000)}d`);
  // any recent job failing with spawn npx ENOENT
  const {data:e}=await db.from("agent_jobs").select("id,kind,status,spec_slug,error,created_at")
    .eq("workspace_id",WS).ilike("error","%spawn npx ENOENT%").order("created_at",{ascending:false}).limit(10);
  console.log(`\n=== jobs erroring 'spawn npx ENOENT' (${(e||[]).length}) ===`);
  for(const r of (e||[]) as any[]) console.log(`  [${r.kind}] ${r.status} slug=${r.spec_slug} age=${Math.round((Date.now()-new Date(r.created_at).getTime())/86400000)}d`);
  // the archived spec row
  const {data:s}=await db.from("specs").select("slug,status,archived_at").eq("workspace_id",WS).like("slug","%sol-ticket-direction-artifact%");
  console.log("\n=== spec rows ===", JSON.stringify(s));
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
