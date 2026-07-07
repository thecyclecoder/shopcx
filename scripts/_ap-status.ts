import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("status,kind,updated_at").order("created_at",{ascending:false}).limit(120);
  process.exit(0);
})();
