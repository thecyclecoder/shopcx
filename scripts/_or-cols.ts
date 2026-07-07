import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data, error } = await db.from("order_refunds").select("*").limit(1);
  if (error) { console.log("select err:", error.message); process.exit(0); }
  console.log("order_refunds columns:", data && data[0] ? Object.keys(data[0]).join(", ") : "(empty table — columns unknown from data)");
  process.exit(0);
})();
