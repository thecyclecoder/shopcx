import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data: cohorts, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("*")
    .eq("workspace_id", WS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  // resolve product titles + account labels
  const productIds = [...new Set((cohorts || []).map((c) => c.product_id).filter(Boolean))];
  const accountIds = [...new Set((cohorts || []).map((c) => c.meta_ad_account_id).filter(Boolean))];
  const prodMap = new Map<string, any>();
  const acctMap = new Map<string, any>();
  if (productIds.length) {
    const { data } = await admin.from("products").select("*").in("id", productIds);
    for (const p of data || []) prodMap.set(p.id, p);
  }
  if (accountIds.length) {
    const { data } = await admin.from("meta_ad_accounts").select("*").in("id", accountIds);
    for (const a of data || []) acctMap.set(a.id, a);
  }

  console.log(`media_buyer_test_cohorts — workspace ${WS} — ${cohorts?.length ?? 0} row(s)\n`);
  for (const c of cohorts || []) {
    const p = c.product_id ? prodMap.get(c.product_id) : null;
    const a = c.meta_ad_account_id ? acctMap.get(c.meta_ad_account_id) : null;
    const title = p ? (p.title ?? p.name ?? "(product w/o title col)") : "(NULL product — account default)";
    const acct = a ? (a.name ?? a.account_name ?? a.meta_ad_account_id ?? a.id) : "(NULL account — workspace default)";
    console.log(`● ${title}`);
    console.log(`    active=${c.is_active}  per_test=${c.adset_per_test}`);
    console.log(`    product_id            = ${c.product_id ?? "NULL"}`);
    console.log(`    meta_ad_account       = ${acct}  (${c.meta_ad_account_id ?? "NULL"})`);
    console.log(`    test_meta_campaign_id = ${c.test_meta_campaign_id ?? "NULL"}`);
    console.log(`    test_meta_adset_id    = ${c.test_meta_adset_id ?? "NULL"}`);
    console.log(`    daily_ceiling         = $${(c.daily_test_ceiling_cents / 100).toFixed(0)}   per_test_budget=$${(c.per_test_daily_budget_cents / 100).toFixed(0)}   maxConcurrent=${Math.floor(c.daily_test_ceiling_cents / c.per_test_daily_budget_cents)}`);
    console.log(`    default_meta_account  = ${c.default_meta_account_id ?? "NULL"}   default_page=${c.default_meta_page_id ?? "NULL"}`);
    console.log(`    notes                 = ${c.notes ?? ""}`);
    console.log("");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
