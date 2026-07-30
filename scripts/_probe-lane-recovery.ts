import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/60000).toFixed(0)}m`:"—";
(async()=>{
  const admin=createAdminClient();
  // build jobs active now
  const { data:b } = await admin.from("agent_jobs").select("spec_slug,status,kind,updated_at").eq("workspace_id",WS)
    .in("status",["queued","claimed","building","queued_resume"]).order("updated_at",{ascending:false});
  console.log("active (queued/claimed/building) jobs:");
  for(const j of b||[]) console.log(`  [${j.status}] ${j.kind} ${j.spec_slug??""} ${ago(j.updated_at)}`);
  // any NEW pr-1893 jobs since we closed it? (storm re-spawning?)
  const { data:pr } = await admin.from("agent_jobs").select("status,created_at").eq("workspace_id",WS).eq("kind","pr-resolve").eq("pr_number",1893).order("created_at",{ascending:false}).limit(3);
  console.log(`\nlatest pr-1893 pr-resolve jobs (should be no NEW ones post-close):`);
  for(const j of pr||[]) console.log(`  [${j.status}] created ${ago(j.created_at)}`);
  // rubric module job?
  const { data:r } = await admin.from("agent_jobs").select("status,kind,created_at").eq("workspace_id",WS).eq("spec_slug","dahlia-conversion-psychology-rubric-module");
  console.log(`\ndahlia-conversion-psychology-rubric-module jobs: ${r?.length??0}`);
  for(const j of r||[]) console.log(`  [${j.status}] ${j.kind} ${ago(j.created_at)}`);
  // needs_attention count now
  const { count } = await admin.from("agent_jobs").select("id",{count:"exact",head:true}).eq("workspace_id",WS).eq("status","needs_attention");
  console.log(`\nneeds_attention total now: ${count}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
