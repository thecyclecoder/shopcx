import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  for(const [n,id] of [["AP","f984a9fb-6eac-4518-ba29-c9db7f1eaa7d"],["backfill-P2","591ac32b-6bd5-434f-833c-d02c21db4c37"]]){
    const {data:j}=await db.from("agent_jobs").select("status").eq("id",id).maybeSingle();
    console.log(`${n}: ${(j as any)?.status}`);
  }
  const {data:or}=await db.from("order_refunds").select("source").limit(2000);
  console.log("order_refunds rows:", (or||[]).length);
  process.exit(0);
})();
