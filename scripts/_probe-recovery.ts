import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ago=(iso:string)=>Math.round((Date.now()-new Date(iso).getTime())/1000)+"s";
(async()=>{
  const a=createAdminClient();
  const hb=await a.from("worker_heartbeats").select("*").order("updated_at",{ascending:false}).limit(3);
  console.log("HEARTBEAT err:", hb.error?.message||"none");
  for(const h of hb.data||[]) console.log("  hb:", h.worker_id||h.box_id, h.status, "updated", ago(h.updated_at));
  const done=await a.from("agent_jobs").select("id,kind,spec_slug,updated_at").eq("workspace_id",WS).eq("status","completed").gte("updated_at",new Date(Date.now()-15*60000).toISOString()).order("updated_at",{ascending:false});
  console.log("\nCOMPLETED last 15m:", (done.data||[]).length);
  for(const j of done.data||[]) console.log("  ✓", j.kind, j.spec_slug||"-", ago(j.updated_at));
  const bld=await a.from("agent_jobs").select("id,status,spec_slug,updated_at").eq("workspace_id",WS).eq("kind","build").in("status",["queued","claimed","building"]).order("updated_at",{ascending:false});
  console.log("\nBUILD lane in-flight:", (bld.data||[]).length);
  for(const j of bld.data||[]) console.log("  ·", j.status, j.spec_slug, ago(j.updated_at));
})().then(()=>process.exit(0));
