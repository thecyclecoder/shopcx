import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:mj }=await a.from("agent_jobs").select("id,spec_slug,instructions,created_at,updated_at").eq("workspace_id",WS).eq("kind","mario").eq("status","queued").order("created_at",{ascending:false}).limit(6);
  for(const j of mj||[]){
    console.log(`\n--- ${j.spec_slug} (created ${j.created_at?.slice(0,16)}) ---`);
    let ins:any={}; try{ ins=JSON.parse(j.instructions||"{}"); }catch(e){ console.log("  (instructions not JSON:", (j.instructions||"").slice(0,80),")"); continue; }
    console.log("  keys:", Object.keys(ins).join(","));
    console.log("  from_event:", ins.from_event, "| to_event:", ins.to_event, "| current_job_status:", ins.brief?.current_job_status);
  }
  // age spread of the queued flood
  const { data:all }=await a.from("agent_jobs").select("created_at").eq("workspace_id",WS).eq("kind","mario").eq("status","queued");
  const now=Date.now();
  const ages=(all||[]).map((r:any)=>Math.round((now-new Date(r.created_at).getTime())/3600000));
  console.log("\nqueued count:", (all||[]).length, "| age hours (min/max):", Math.min(...ages), "/", Math.max(...ages));
  const recent=ages.filter(h=>h<1).length;
  console.log("created in last 1h:", recent);
})().then(()=>process.exit(0));
