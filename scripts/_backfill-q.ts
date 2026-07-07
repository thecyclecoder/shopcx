import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: j } = await db.from("agent_jobs").select("questions, session_note").eq("id","be78ec7a-02d9-4fd8-a054-5feade6a705a").maybeSingle();
  console.log(JSON.stringify((j as any).questions, null, 2));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
