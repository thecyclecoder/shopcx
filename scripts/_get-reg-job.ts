import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  const {data}=await db.from("agent_jobs").select("id,status,spec_slug")
    .eq("workspace_id",WS).eq("kind","regression").eq("status","needs_attention")
    .like("spec_slug","%media-buyer-digest%").limit(3);
  for(const j of (data||[]) as any[]) console.log(`regression job ${j.id} status=${j.status} slug=${j.spec_slug}`);
})().then(()=>process.exit(0));
