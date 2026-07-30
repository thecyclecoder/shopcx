import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const {data}=await db.from("agent_jobs").select("kind,status,created_at").eq("spec_slug","sol-ticket-direction-artifact-and-first-touch-box-session").order("created_at",{ascending:false}).limit(6);
for(const j of data||[]) console.log(`  [${(j as any).status}] ${(j as any).kind} @${(j as any).created_at?.slice(11,19)}`);
process.exit(0);})();
