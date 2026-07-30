import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  // 1. agent_jobs LIKE sol-ticket-direction (any status/kind)
  const {data:j}=await db.from("agent_jobs").select("id,kind,status,spec_slug,error,created_at,needs_attention_class")
    .eq("workspace_id",WS).like("spec_slug","%sol-ticket-direction%").order("created_at",{ascending:false}).limit(8);
  console.log(`=== agent_jobs LIKE sol-ticket-direction (${(j||[]).length}) ===`);
  for(const r of (j||[]) as any[]) console.log(`  [${r.kind}] ${r.status} (${r.needs_attention_class||"-"}) slug=${r.spec_slug} age=${Math.round((Date.now()-new Date(r.created_at).getTime())/86400000)}d err=${String(r.error||"").slice(0,60)}`);
  // 2. dashboard_notifications referencing it
  const {data:n}=await db.from("dashboard_notifications").select("id,type,dismissed_at,created_at,body,title")
    .eq("workspace_id",WS).or("title.ilike.%sol-ticket%,body.ilike.%sol-ticket-direction%").order("created_at",{ascending:false}).limit(8);
  console.log(`\n=== dashboard_notifications LIKE sol-ticket (${(n||[]).length}) ===`);
  for(const r of (n||[]) as any[]) console.log(`  ${r.id} type=${r.type} dismissed=${r.dismissed_at?"Y":"N"} title=${String(r.title||"").slice(0,50)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
