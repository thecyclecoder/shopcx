import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("id,status,spec_slug,pending_actions,created_at").order("created_at",{ascending:false}).limit(250);
  for(const j of jobs||[]){
    for(const a of ((j as any).pending_actions||[])){
      if((a.cmd||"").includes("from-events")){
        console.log(`job=${(j as any).id} [${(j as any).status}] slug=${(j as any).spec_slug} action=${a.id} status=${a.status||"pending"} apply=${(a.cmd||"").includes("--apply")}`);
      }
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
