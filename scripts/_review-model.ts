import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data } = await db.from("sonnet_prompts").select("auto_decision_model,auto_decision_at").not("auto_decision_model","is",null).order("auto_decision_at",{ascending:false}).limit(5);
  const models = new Set((data||[]).map((r:any)=>r.auto_decision_model));
  console.log("auto_decision_model values:", JSON.stringify([...models]));
  process.exit(0);
})();
