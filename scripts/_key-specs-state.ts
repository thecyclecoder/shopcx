import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KEY=["dahlia-copy-author-box-session","dahlia-produces-3-placement-multi-copy-creative-pack","bianca-publishes-3-placement-multi-copy-via-placement-customization","goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock"];
(async()=>{
  const admin=createAdminClient();
  for(const slug of KEY){
    const { data:b }=await admin.from("agent_jobs").select("status,error,updated_at").eq("workspace_id",WS).eq("spec_slug",slug).eq("kind","build").order("updated_at",{ascending:false}).limit(1);
    const j=(b||[])[0];
    console.log(`${slug}\n   build: ${j?`${j.status} @${j.updated_at} ${j.error?"ERR:"+String(j.error).slice(0,70):""}`:"(no build job)"}`);
  }
  const { data:mq }=await admin.from("agent_jobs").select("status").eq("kind","mario").in("status",["queued","building"]);
  console.log("\nmario active:", (mq||[]).length);
})().then(()=>process.exit(0));
