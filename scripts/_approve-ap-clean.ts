import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const uid=(await db.from("workspace_members").select("user_id").eq("workspace_id",WS).eq("role","owner").limit(1)).data?.[0]?.user_id;
  const r = await approveRoadmapAction(WS, uid!, { jobId:"f984a9fb-6eac-4518-ba29-c9db7f1eaa7d", actionId:"amrauzarj0", decision:"approve", notes:"Clean pgClient apply-script (working method, not the broken db push). Seed migration reviewed earlier: additive, idempotent, re-enumerates existing step types. Approved." });
  console.log("AP amrauzarj0 ->", r.ok?"approved":JSON.stringify(r).slice(0,150));
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
