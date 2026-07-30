import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { investigateSpec } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  // the stuck build job
  const { data:job }=await a.from("agent_jobs").select("id,status,spec_slug,spec_branch,pr_number,needs_attention_class,error,updated_at,milestone_id").eq("id","b27426e7").maybeSingle().then(r=>r,()=>({data:null}));
  // fallback: query by slug if id short
  let j:any=job;
  if(!j){ const { data }=await a.from("agent_jobs").select("id,status,spec_slug,spec_branch,pr_number,needs_attention_class,error,updated_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","dahlia-copy-author-box-session").order("updated_at",{ascending:false}).limit(3); console.log("build jobs for slug:", JSON.stringify(data,null,1)); }
  else console.log("job:", JSON.stringify(j,null,1));
  // spec investigation
  try{ const inv:any=await investigateSpec(WS,"dahlia-copy-author-box-session"); console.log("\n=== investigateSpec ===\n", JSON.stringify({status:inv?.status, goal:inv?.goalSlug, phases:inv?.phases?.map((p:any)=>p.status), summary:inv?.summary||inv?.diagnosis}, null, 1).slice(0,1500)); }catch(e:any){ console.log("investigateSpec err:", e.message); }
})().then(()=>process.exit(0));
