import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ago=(iso:string)=>Math.round((Date.now()-new Date(iso).getTime())/1000)+"s";
(async()=>{
  const a=createAdminClient();
  const { data:jobs }=await a.from("agent_jobs").select("id,status,needs_attention_class,spec_branch,error,updated_at").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","dahlia-copy-author-box-session").order("updated_at",{ascending:false}).limit(4);
  for(const j of jobs||[]) console.log(`${(j as any).id.slice(0,8)} ${(j as any).status}${(j as any).needs_attention_class?"/"+(j as any).needs_attention_class:""} (${ago((j as any).updated_at)}) ${((j as any).error||"").slice(0,90)}`);
})().then(()=>process.exit(0));
