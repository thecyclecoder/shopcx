import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  for (const t of ["refunds","order_refunds"]) {
    const { error, count } = await db.from(t).select("*", { count:"exact", head:true });
    console.log(t+":", error ? `MISSING (${error.message.slice(0,50)})` : `EXISTS (rows=${count})`);
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
