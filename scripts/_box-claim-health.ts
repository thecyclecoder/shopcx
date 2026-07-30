import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const nowMs=Date.now();
  // box heartbeat
  const { data:hb }=await admin.from("worker_heartbeats").select("*").order("updated_at",{ascending:false}).limit(3).then((r:any)=>r).catch(()=>({data:null}));
  if(hb) for(const h of hb) console.log(`box ${h.box_id||h.id||"?"}: status=${h.status} active=${h.active_builds} last=${h.updated_at||h.last_heartbeat_at} (${Math.round((nowMs-Date.parse(h.updated_at||h.last_heartbeat_at))/1000)}s ago)`);
  else console.log("(no worker_heartbeats table/rows)");
  // building jobs age
  const { data:bld }=await admin.from("agent_jobs").select("spec_slug,kind,claimed_at,updated_at").eq("status","building").order("claimed_at",{ascending:true});
  console.log("\nBUILDING jobs:");
  for(const j of bld||[]) console.log(`  ${j.kind} ${j.spec_slug} claimed=${j.claimed_at} (${Math.round((nowMs-Date.parse(j.claimed_at))/60000)}m ago) upd=${j.updated_at}`);
  // dahlia-produces claimed_at (future backoff?)
  const { data:dp }=await admin.from("agent_jobs").select("claimed_at,updated_at,created_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","dahlia-produces-3-placement-multi-copy-creative-pack").eq("status","queued").maybeSingle();
  if(dp) console.log(`\ndahlia-produces queued build: claimed_at=${dp.claimed_at} (future=${dp.claimed_at?Date.parse(dp.claimed_at)>nowMs:false}) created=${dp.created_at}`);
  // worker_controls (drain?)
  const { data:wc }=await admin.from("worker_controls").select("*").then((r:any)=>r).catch(()=>({data:null}));
  console.log("\nworker_controls:", wc?JSON.stringify(wc):"(none)");
})().then(()=>process.exit(0));
