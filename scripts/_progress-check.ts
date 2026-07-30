import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const nowMs=Date.now();
  // builds that completed/merged in the last 30 min (forward progress since box recovery?)
  const since=new Date(nowMs-30*60*1000).toISOString();
  const { data:done }=await admin.from("agent_jobs").select("spec_slug,status,updated_at").eq("workspace_id",WS).eq("kind","build").in("status",["completed","merged"]).gte("updated_at",since).order("updated_at",{ascending:false}).limit(10);
  console.log("builds completed/merged in last 30min:", (done||[]).length);
  for(const j of done||[]) console.log(`  ${j.status} ${j.spec_slug} @${j.updated_at}`);
  // current building + dahlia-produces
  const { data:bld }=await admin.from("agent_jobs").select("spec_slug,claimed_at").eq("status","building").eq("kind","build");
  console.log("\ncurrently building:", (bld||[]).map(b=>`${b.spec_slug}(${Math.round((nowMs-Date.parse(b.claimed_at))/60000)}m)`).join(", ")||"NONE");
  const { data:dp }=await admin.from("agent_jobs").select("status,claimed_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","dahlia-produces-3-placement-multi-copy-creative-pack").order("updated_at",{ascending:false}).limit(1);
  console.log("dahlia-produces build:", JSON.stringify(dp?.[0]));
})().then(()=>process.exit(0));
