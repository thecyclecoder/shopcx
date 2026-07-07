import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  for (const t of ["refunds","order_refunds"]) {
    const { data, error, count } = await db.from(t).select("*", { count:"exact" }).limit(3);
    if (error) { console.log(`\n${t}: ERROR ${error.message}`); continue; }
    console.log(`\n=== ${t} — rows=${count} ===`);
    if (data && data[0]) {
      console.log("columns:", Object.keys(data[0]).join(", "));
      for (const r of data) console.log("  row:", JSON.stringify(r).slice(0,300));
    } else {
      console.log("(empty — no rows; columns unknown from data)");
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
