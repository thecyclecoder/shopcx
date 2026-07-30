import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin = createAdminClient();
  const { data } = await admin.from("meta_insights_daily")
    .select("*").eq("workspace_id",WS).eq("level","adset").order("snapshot_date",{ascending:false}).limit(1);
  console.log("=== meta_insights_daily (adset) columns ===");
  console.log(data?.[0]? Object.keys(data[0]).join(", ") : "(no rows)");
  console.log("\nsample row:", JSON.stringify(data?.[0], null, 2));
  // meta_adsets shape (structure/status)
  const { data: as } = await admin.from("meta_adsets").select("*").eq("workspace_id",WS).limit(1);
  console.log("\n=== meta_adsets columns ===");
  console.log(as?.[0]? Object.keys(as[0]).join(", ") : "(no rows)");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
