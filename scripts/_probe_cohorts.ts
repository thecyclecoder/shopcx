import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("product_id, meta_ad_account_id, test_meta_campaign_id, test_meta_adset_id, per_test_daily_budget_cents, adset_per_test, is_active")
    .eq("workspace_id", WS);
  const { data: prods } = await admin.from("products").select("id, title").eq("workspace_id", WS);
  const { data: accts } = await admin.from("meta_ad_accounts").select("id, meta_account_id, meta_account_name").eq("workspace_id", WS);
  const pName = new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  const aName = new Map((accts||[]).map((a:any)=>[a.id, `${a.meta_account_name} (${a.meta_account_id})`]));
  console.log(`=== media_buyer_test_cohorts: ${(cohorts||[]).length} rows ===`);
  for (const c of (cohorts||[]) as any[]) {
    console.log(`\nproduct: ${pName.get(c.product_id) ?? c.product_id}`);
    console.log(`  account:      ${aName.get(c.meta_ad_account_id) ?? c.meta_ad_account_id}`);
    console.log(`  test campaign:${c.test_meta_campaign_id ?? "—"}`);
    console.log(`  test adset:   ${c.test_meta_adset_id ?? "—"}  per-test $${(c.per_test_daily_budget_cents??0)/100}/day  adsetPerTest=${c.adset_per_test}  active=${c.is_active}`);
  }
  console.log(`\n=== all products (${(prods||[]).length}) ===`);
  for (const p of (prods||[]) as any[]) console.log(`  ${p.title}  ${p.id}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
