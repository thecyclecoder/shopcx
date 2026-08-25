/** Verify every scaler campaign is ABO, PAUSED, in the right account, and stamped on its cohort. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const { data: cohorts } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id,product_id,meta_ad_account_id,scaler_meta_campaign_id,daily_scaler_ceiling_cents,is_active")
    .eq("workspace_id", WS).eq("is_active", true);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const { data: accts } = await admin.from("meta_ad_accounts").select("id,meta_account_id,meta_account_name").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));
  const acct = new Map((accts ?? []).map((a) => [String(a.id), a]));

  console.log(`active cold-scaler cohorts: ${(cohorts ?? []).length}\n`);
  let allGood = true;

  for (const c of (cohorts ?? []).sort((a, b) => String(title.get(String(a.product_id))).localeCompare(String(title.get(String(b.product_id)))))) {
    const camp = String(c.scaler_meta_campaign_id ?? "");
    const a = acct.get(String(c.meta_ad_account_id));
    if (!camp) { console.log(`❌ ${title.get(String(c.product_id))} — cohort has NO stamped campaign`); allGood = false; continue; }

    const j = await fetch(
      `https://graph.facebook.com/v21.0/${camp}?fields=id,name,status,effective_status,daily_budget,lifetime_budget,account_id,objective&access_token=${encodeURIComponent(token)}`,
    ).then((r) => r.json()) as Record<string, unknown>;

    if (j.error) { console.log(`❌ ${title.get(String(c.product_id))} — Graph error: ${JSON.stringify(j.error)}`); allGood = false; continue; }

    const isAbo = j.daily_budget == null && j.lifetime_budget == null;
    const paused = String(j.effective_status) === "PAUSED";
    const rightAccount = String(j.account_id) === String(a?.meta_account_id);
    const good = isAbo && paused && rightAccount;
    if (!good) allGood = false;

    console.log(`${good ? "✅" : "❌"} ${String(j.name)}`);
    console.log(`     ${isAbo ? "ABO (no campaign budget)" : `⚠ CBO — daily_budget=${j.daily_budget}`} · ${j.effective_status} · ${j.objective}`);
    console.log(`     account act_${j.account_id} ${rightAccount ? `= ${a?.meta_account_name} ✓` : `⚠ EXPECTED act_${a?.meta_account_id}`}`);
    console.log(`     cohort ${String(c.id).slice(0, 8)} · ceiling $${Number(c.daily_scaler_ceiling_cents) / 100}/day (governance only on ABO)`);
  }

  console.log(`\n${allGood ? "✅ every scaler is ABO, PAUSED, in the right account, and stamped." : "❌ one or more scalers need attention."}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
