import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function isTerminal(slug:string):Promise<boolean>{
  const s:any=await getSpec(WS,slug).catch(()=>null);
  if(!s) return false;
  if(s.status==="folded"||s.status==="deferred") return true;
  return (s.phases||[]).length>0 && (s.phases||[]).every((p:any)=>p.status==="shipped");
}
(async()=>{
  const a=createAdminClient();
  const { data:mj }=await a.from("agent_jobs").select("id,spec_slug").eq("workspace_id",WS).eq("kind","mario").in("status",["queued","queued_resume"]);
  let cancelled=0, kept=0;
  for(const j of mj||[]){
    if(j.spec_slug && await isTerminal(j.spec_slug)){
      await a.from("agent_jobs").update({status:"cancelled", error:"mario-enqueue-terminal-spec-guard (CEO 2026-07-16 #1924): Mario does not work on archived/folded specs; flood cleared at source.", updated_at:new Date().toISOString()}).eq("id",j.id);
      cancelled++;
    } else kept++;
  }
  console.log(`cancelled ${cancelled} terminal-spec mario flood jobs; kept ${kept} non-terminal queued mario job(s)`);
})().then(()=>process.exit(0));
