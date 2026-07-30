import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:mj }=await a.from("agent_jobs").select("id,spec_slug,instructions,created_at").eq("workspace_id",WS).eq("kind","mario").eq("status","queued").limit(60);
  console.log("queued mario jobs:", (mj||[]).length);
  const slugs=[...new Set((mj||[]).map((j:any)=>j.spec_slug).filter(Boolean))];
  const { data:specs }=await a.from("specs").select("slug,status").in("slug",slugs);
  const byStatus:Record<string,number>={};
  const statusBySlug=new Map((specs||[]).map((s:any)=>[s.slug,s.status]));
  const fromEvents:Record<string,number>={};
  for(const j of mj||[]){
    const st=statusBySlug.get(j.spec_slug)??"(no-row)";
    byStatus[st]=(byStatus[st]||0)+1;
    let fe="?"; try{ fe=JSON.parse(j.instructions||"{}").from_event||"?"; }catch{}
    fromEvents[fe]=(fromEvents[fe]||0)+1;
  }
  console.log("by spec status:", JSON.stringify(byStatus));
  console.log("by from_event:", JSON.stringify(fromEvents));
})().then(()=>process.exit(0));
