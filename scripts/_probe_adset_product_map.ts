import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function cols(admin: any, table: string) {
  const { data, error } = await admin.from(table).select("*").limit(1);
  if (error) return `  ${table}: ERR ${error.message}`;
  const c = data?.[0] ? Object.keys(data[0]) : [];
  return `  ${table}: [${c.join(", ")}]`;
}

async function main() {
  const admin = createAdminClient();
  console.log("=== candidate mapping-table columns ===");
  for (const t of ["ad_campaigns", "meta_campaigns", "meta_adsets", "ad_publish_jobs", "creative_test_outcomes", "media_buyer_test_cohorts", "product_ad_account_mappings", "meta_ad_accounts", "products"]) {
    console.log(await cols(admin, t));
  }

  console.log("\n=== ad_campaigns: product_id + any meta ids populated? ===");
  const { data: ac } = await admin.from("ad_campaigns")
    .select("id, product_id, name, status")
    .eq("workspace_id", WS).limit(5);
  console.log(JSON.stringify(ac, null, 2));

  console.log("\n=== meta_ad_accounts rows ===");
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id, meta_account_id, meta_account_name")
    .eq("workspace_id", WS);
  console.log(JSON.stringify(accts, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
