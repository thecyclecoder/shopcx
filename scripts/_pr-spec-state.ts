import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("status,kind,spec_slug").order("created_at",{ascending:false}).limit(120);
  const g=(jobs||[]).filter((j:any)=>j.spec_slug==="prompt-auto-review-becomes-box-agent-under-june");
  console.log("prompt-review jobs:", g.length? g.map((j:any)=>`${j.kind}:${j.status}`).join(", "):"(none yet — editable)");
  process.exit(0);
})();
