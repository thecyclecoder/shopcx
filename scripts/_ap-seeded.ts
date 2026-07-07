import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data } = await db.from("playbooks").select("name,is_active").in("name",["Assisted Order Purchase","Assisted Subscription Purchase"]);
  console.log("assisted-purchase playbooks in prod:", (data||[]).length, JSON.stringify(data));
  process.exit(0);
})();
