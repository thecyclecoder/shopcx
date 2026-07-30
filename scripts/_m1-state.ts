import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const {data:jobs}=await db.from("agent_jobs").select("kind,status,spec_slug,created_at").in("spec_slug",["sol-ticket-direction-artifact-and-first-touch-box-session","sol-cheap-execution-over-ticket-direction"]).order("created_at",{ascending:false}).limit(12);
for(const j of jobs||[]) console.log(`[${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug?.replace('sol-','')} ${(j as any).created_at?.slice(11,19)}`);
process.exit(0);})();
