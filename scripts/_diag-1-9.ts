import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  console.log("=== [1] regression jobs on media-buyer-digest ===");
  const {data:reg}=await db.from("agent_jobs").select("id,kind,status,spec_slug,error,log_tail,created_at")
    .eq("workspace_id",WS).eq("kind","regression").order("created_at",{ascending:false}).limit(5);
  for(const j of (reg||[]) as any[]) console.log(`[regression] ${j.status} slug=${j.spec_slug} age=${Math.round((Date.now()-new Date(j.created_at).getTime())/60000)}m\n   err:${String(j.error||"").replace(/\n/g," ").slice(0,200)}\n   log:${String(j.log_tail||"").replace(/\n/g," ").slice(0,200)}`);
  console.log("\n=== [9] storefront-optimizer parked jobs ===");
  const {data:sf}=await db.from("agent_jobs").select("id,kind,status,spec_slug,error,log_tail,created_at")
    .eq("workspace_id",WS).eq("kind","storefront-optimizer").in("status",["needs_attention","queued","building"]).order("created_at",{ascending:false}).limit(5);
  for(const j of (sf||[]) as any[]) console.log(`[storefront] ${j.status} slug=${j.spec_slug} age=${Math.round((Date.now()-new Date(j.created_at).getTime())/60000)}m\n   err:${String(j.error||"").replace(/\n/g," ").slice(0,200)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
