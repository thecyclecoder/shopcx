import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("status,kind,spec_slug,updated_at").order("updated_at",{ascending:false}).limit(8);
  for(const j of jobs||[]) console.log(`${(j as any).updated_at?.slice(11,19)} [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug||""}`);
  process.exit(0);
})();
