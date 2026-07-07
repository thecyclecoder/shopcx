import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const BP="23e0ea01-fea1-4aa2-90f3-bad2d856f654";
let last="";
for(let i=0;i<24;i++){
  try{
    const { data: jobs }=await sb.from("agent_jobs").select("status,error").eq("kind","dr-content").eq("spec_slug",BP);
    const j=(jobs&&jobs[0])||null;
    const { data: bp }=await sb.from("lander_blueprints").select("status,content").eq("id",BP).maybeSingle();
    const { count: gaps }=await sb.from("lander_content_gaps").select("id",{count:"exact",head:true}).eq("blueprint_id",BP);
    const line=`job=${j?j.status:"?"} | blueprint=${bp?bp.status:"?"} | content=${bp&&bp.content?"filled":"empty"} | gaps=${gaps||0}`;
    if(line!==last){ console.log(new Date().toISOString(), line); last=line; }
    if(j && ["completed","failed","error"].includes(j.status)){
      console.log(">> CARRIE JOB DONE:", j.status, j.error?("err: "+j.error):"");
      console.log("blueprint status:", bp?.status, "| content blocks:", bp?.content?.blocks?.length||0, "| gaps:", gaps);
      break;
    }
  }catch(e){ console.log("poll err (transient):", (e&&e.message)||e); }
  await sleep(90000);
}
process.exit(0);
