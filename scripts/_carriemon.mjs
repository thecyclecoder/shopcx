import { loadEnv } from "./_bootstrap.ts";
loadEnv();
import { createClient } from "@supabase/supabase-js";
const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
let last="";
for(let i=0;i<24;i++){
  const { data: sp }=await sb.from("specs").select("id,status").eq("slug","carrie-dr-content").single();
  const { data: ph }=await sb.from("spec_phases").select("status").eq("spec_id",sp.id);
  const shipped=(ph||[]).filter(x=>x.status==="shipped").length;
  const { data: fail }=await sb.from("agent_jobs").select("kind,status").eq("spec_slug","carrie-dr-content").in("status",["failed","error"]).gte("created_at",new Date(Date.now()-3*3600*1000).toISOString());
  const line=`carrie-dr-content: ${sp.status} (${shipped}/${(ph||[]).length} shipped)`;
  if(line!==last){ console.log(new Date().toISOString(), line); last=line; }
  if(fail && fail.length){ console.log("!! CARRIE BUILD FAILURE:", JSON.stringify(fail)); break; }
  if(["shipped","folded"].includes(sp.status) || (ph.length>0 && shipped===ph.length)){ console.log(">> CARRIE BUILT — trigger Cleo sweep + un-defer upload spec"); break; }
  await sleep(180000);
}
process.exit(0);
