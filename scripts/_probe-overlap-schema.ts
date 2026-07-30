import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function cols(t: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from(t).select("*").eq("workspace_id", WS).limit(1);
  if (error) { console.log(`\n${t}: ERR ${error.message}`); return; }
  console.log(`\n${t}: ${data?.length ? Object.keys(data[0]).join(", ") : "(0 ws rows)"}`);
  if (!data?.length) {
    const { data: d2 } = await admin.from(t).select("*").limit(1);
    console.log(`   any-row cols: ${d2?.length ? Object.keys(d2[0]).join(", ") : "(empty table)"}`);
  }
}
async function main() {
  for (const t of ["orders","customers","meta_attribution_daily","meta_insights_daily","ad_publish_jobs","media_buyer_test_cohorts"]) {
    await cols(t);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
