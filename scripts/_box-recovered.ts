import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient(); const nowMs=Date.now();
  const { data:hb }=await admin.from("worker_heartbeats").select("status,active_builds,updated_at").order("updated_at",{ascending:false}).limit(1);
  const h=(hb||[])[0];
  const beatAge=h?Math.round((nowMs-Date.parse(h.updated_at))/60000):-1;
  const { data:bld }=await admin.from("agent_jobs").select("spec_slug").eq("status","building").eq("kind","build");
  const { data:done }=await admin.from("agent_jobs").select("id").eq("kind","build").in("status",["completed","merged"]).gte("updated_at",new Date(nowMs-16*60*1000).toISOString());
  console.log(`BOX: heartbeat ${beatAge}m ago status=${h?.status} | building=${(bld||[]).length} | completed-last16m=${(done||[]).length}`);
  console.log((bld||[]).length||(done||[]).length ? "→ box WORKING" : "→ box STILL DOWN");
})().then(()=>process.exit(0));
