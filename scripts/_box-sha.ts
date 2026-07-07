import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const db=createAdminClient();
  const { data: hb } = await db.from("worker_heartbeats").select("running_sha,status,active_builds,last_poll_at,started_at").eq("id","box").maybeSingle();
  const h=hb as any;
  console.log("box running_sha:", h?.running_sha);
  console.log("main HEAD:        c1dcd9ce (with fix)");
  console.log("status:", h?.status, "| active_builds:", h?.active_builds, "| last_poll:", h?.last_poll_at?.slice(11,19), "| started:", h?.started_at?.slice(11,19));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
