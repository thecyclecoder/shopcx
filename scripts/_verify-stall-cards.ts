/**
 * Are the cold-scaler stall cards CORRECT?
 *
 * They claim cohort 025c4a13 has "3 crowned winners" and f6eaccfb has "2" awaiting graduation.
 * countEligibleCrownedWinnersByCohort filters ONLY on `graduated_at IS NULL` — it does not exclude
 * crowns that were REVOKED (exploit_exhausted). All 5 crowns were revoked 2026-08-25 because none
 * qualifies under the current policy. So the question is whether the cards are counting retired
 * records as pending work.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { detectMetaCpaWinners } from "../src/lib/media-buyer/meta-cpa-signal";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CARDS = [
  { cohort: "025c4a13-160c-40bb-ac85-370c9570b892", claims: 3, label: "Superfood Tabs" },
  { cohort: "f6eaccfb-d74e-494b-9613-60d648965a30", claims: 2, label: "Ashwavana Zen Relax" },
];

async function main() {
  const admin = createAdminClient();

  const { data: winners } = await admin.from("media_buyer_crowned_winners")
    .select("test_meta_adset_id,product_id,meta_ad_account_id,graduated_at,exploit_exhausted,exploit_exhausted_at,created_at")
    .eq("workspace_id", WS);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  console.log("=== every crown marker ===");
  for (const w of winners ?? []) {
    console.log(`  ${String(w.test_meta_adset_id).slice(-10)} ${String(title.get(String(w.product_id)) ?? "?").padEnd(22)} graduated_at=${w.graduated_at ?? "NULL"} exploit_exhausted=${w.exploit_exhausted} (${String(w.exploit_exhausted_at ?? "").slice(0, 10) || "—"})`);
  }
  const eligibleByCardLogic = (winners ?? []).filter((w) => w.graduated_at === null).length;
  const eligibleIfRevokedExcluded = (winners ?? []).filter((w) => w.graduated_at === null && w.exploit_exhausted === false).length;
  console.log(`\n  counted by the CARD's logic (graduated_at IS NULL):        ${eligibleByCardLogic}`);
  console.log(`  counted if revoked crowns are excluded:                    ${eligibleIfRevokedExcluded}`);

  console.log("\n=== per card ===");
  for (const c of CARDS) {
    const { data: co } = await admin.from("media_buyer_cold_scaler_cohorts")
      .select("id,product_id,meta_ad_account_id,is_active,created_at").eq("id", c.cohort).maybeSingle();
    const scoped = (winners ?? []).filter(
      (w) => String(w.meta_ad_account_id) === String(co?.meta_ad_account_id) && String(w.product_id) === String(co?.product_id),
    );
    const live = scoped.filter((w) => w.graduated_at === null && w.exploit_exhausted === false);
    const ageDays = co ? Math.round((Date.now() - Date.parse(String(co.created_at))) / 86400000) : null;
    console.log(`\n  ${c.label} — cohort ${c.cohort.slice(0, 8)}`);
    console.log(`     card claims          ${c.claims} crowned winners awaiting graduate`);
    console.log(`     matching crown rows  ${scoped.length}  (card's count — includes revoked)`);
    console.log(`     NOT revoked          ${live.length}  ← genuine pending work`);
    console.log(`     cohort age           ${ageDays}d (created ${String(co?.created_at).slice(0, 10)}) vs the card's 7-day window`);
  }

  console.log("\n=== does anything qualify under the CURRENT policy? ===");
  const { data: accts } = await admin.from("meta_ad_accounts").select("id,meta_account_name").eq("workspace_id", WS);
  const { data: pol } = await admin.from("iteration_policies")
    .select("crown_max_cpa_cents,crown_min_spend_cents,crown_min_purchases")
    .eq("workspace_id", WS).eq("status", "active").limit(1).maybeSingle();
  for (const a of accts ?? []) {
    const w = await detectMetaCpaWinners(admin, {
      workspaceId: WS, metaAdAccountId: String(a.id),
      crownMaxCpaCents: Number(pol?.crown_max_cpa_cents),
      crownMinSpendCents: Number(pol?.crown_min_spend_cents),
      crownMinPurchases: Number(pol?.crown_min_purchases),
    });
    console.log(`  ${String(a.meta_account_name).padEnd(26)} ${w.length} qualifying winner(s)`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
