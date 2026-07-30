import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const hrs=(iso:string)=>((Date.now()-new Date(iso).getTime())/3600000).toFixed(1)+"h";
(async()=>{
  const a=createAdminClient();
  // all active jobs, oldest first
  const { data:jobs }=await a.from("agent_jobs").select("id,kind,status,spec_slug,created_at,claimed_at,needs_attention_class,error").eq("workspace_id",WS).in("status",["queued","queued_resume","needs_attention","needs_approval","needs_input","claimed","building","blocked_on_usage"]).order("created_at",{ascending:true}).limit(40);
  console.log("active jobs:", (jobs||[]).length);
  for(const j of jobs||[]){
    const age=hrs((j as any).created_at);
    const claimed=(j as any).claimed_at ? `claimed_at=${hrs((j as any).claimed_at)}` : "unclaimed";
    console.log(`  ${age.padStart(6)} ${(j as any).kind}/${(j as any).status}${(j as any).needs_attention_class?"/"+(j as any).needs_attention_class:""} ${(j as any).spec_slug||""} [${claimed}] ${((j as any).error||"").slice(0,70)}`);
  }
})().then(()=>process.exit(0));
