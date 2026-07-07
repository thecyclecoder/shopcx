import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: j } = await db.from("agent_jobs").select("pending_actions").eq("id","f984a9fb-6eac-4518-ba29-c9db7f1eaa7d").maybeSingle();
  const a=((j as any).pending_actions||[]).find((x:any)=>x.id==="amrasebc90");
  console.log("status:", a?.status);
  console.log("FULL result:\n", a?.result || "(none)");
  process.exit(0);
})();
