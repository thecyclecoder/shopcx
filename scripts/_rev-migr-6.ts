import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data, error, count } = await admin.from("subscriptions").select("id, shopify_contract_id, status, next_billing_date, billing_source, workspace_id", { count: "exact" }).limit(3);
  console.log("err", error, "count", count, JSON.stringify(data));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
