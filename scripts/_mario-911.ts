import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs")
    .select("id,status,spec_slug,created_at,updated_at,claimed_at,attempts,error,pending_actions")
    .eq("kind","mario").order("created_at",{ascending:false}).limit(80);
  const all=jobs||[];
  const byStatus:Record<string,number>={};
  for(const j of all) byStatus[j.status]=(byStatus[j.status]||0)+1;
  console.log("=== mario jobs by status (last 80) ===", JSON.stringify(byStatus));
  console.log("total pulled:", all.length);
  console.log("\n=== oldest→newest queued/claimed (first 20) ===");
  const active=all.filter(j=>["queued","claimed","building","queued_resume","needs_input","needs_approval","needs_attention"].includes(j.status))
    .sort((a,b)=>a.created_at.localeCompare(b.created_at));
  for(const j of active.slice(0,20)) console.log(`  ${j.status.padEnd(13)} ${j.spec_slug||"-"} | created ${j.created_at} att ${j.attempts} ${j.error?("ERR:"+String(j.error).slice(0,50)):""}`);
  console.log("active mario count:", active.length);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
