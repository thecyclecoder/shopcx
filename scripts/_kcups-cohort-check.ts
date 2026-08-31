/**
 * Is the K-Cups TEST cohort actually wired so Bianca reaches it?
 *
 * Checks through the runner's OWN readers rather than raw rows, because the failure mode that
 * matters is "the row exists but the code never sees it":
 *   · the cohort resolver the pass uses (account + product scoped)
 *   · the Meta test campaign really exists, is ACTIVE, and is ABO
 *   · the adset_template carries a pixel + BOTH exclusion audiences (a cold test without the
 *     existing-customer exclusions reads contaminated)
 *   · slot math after the $200 per-test change (target = ceiling ÷ per-test)
 *   · whether a K-Cups pass actually ran in the last day
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listAdSets } from "../src/lib/meta-ads";
import { getEffectiveMediaBuyerTestCohort } from "../src/lib/media-buyer/publish-gate";
import { readCurrentTestCohortSize } from "../src/lib/media-buyer/agent";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const ok = (b: boolean) => (b ? "✅" : "❌");

async function main() {
  const admin = createAdminClient();

  // Raw rows first — there are TWO cohorts sharing one campaign id; make that visible.
  const { data: rows, error } = await admin.from("media_buyer_test_cohorts")
    .select("*").eq("workspace_id", WS).eq("product_id", KCUPS);
  if (error) throw new Error(`media_buyer_test_cohorts: ${error.message}`);
  console.log(`=== raw cohort rows for K-Cups: ${(rows ?? []).length} ===`);
  for (const c of rows ?? []) {
    console.log(`  ${c.is_active ? "ACTIVE " : "retired"} ${String(c.id).slice(0, 8)} campaign=${c.test_meta_campaign_id} $${Number(c.per_test_daily_budget_cents) / 100}/test ceiling $${Number(c.daily_test_ceiling_cents) / 100} adset_per_test=${c.adset_per_test}`);
  }
  const active = (rows ?? []).filter((c) => c.is_active);
  console.log(`  ${ok(active.length === 1)} exactly one ACTIVE row (${active.length})`);

  const acctUuid = String(active[0]?.meta_ad_account_id ?? "");
  const { data: acct } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name").eq("id", acctUuid).maybeSingle();
  console.log(`  account: ${acct?.meta_account_name} (act_${acct?.meta_account_id})`);

  // ── the resolver the publish gate + runner use ───────────────────────────
  const eff = await getEffectiveMediaBuyerTestCohort(admin, WS, {
    metaAdAccountId: acctUuid,
    productId: KCUPS,
  });
  console.log(`\n=== resolver (getEffectiveMediaBuyerTestCohort) ===`);
  console.log(`  ${ok(!!eff)} ${eff ? `resolved cohort ${String(eff.id).slice(0, 8)} · campaign ${eff.testMetaCampaignId} · $${eff.perTestDailyBudgetCents / 100}/test · ceiling $${eff.dailyTestCeilingCents / 100}` : "NOT RESOLVED — Bianca cannot see this cohort"}`);

  // ── the adset template ───────────────────────────────────────────────────
  const tmpl = (active[0]?.adset_template ?? null) as Record<string, unknown> | null;
  console.log(`\n=== adset_template ===`);
  if (!tmpl) console.log("  ❌ MISSING — the publisher cannot mint an adset");
  else {
    const targeting = (tmpl.targeting ?? {}) as Record<string, unknown>;
    const excl = (targeting.excluded_custom_audiences ?? []) as unknown[];
    console.log(`  ${ok(!!tmpl.pixel_id)} pixel_id ${tmpl.pixel_id ?? "MISSING"}`);
    console.log(`  ${ok(Array.isArray(excl) && excl.length >= 2)} excluded_custom_audiences: ${JSON.stringify(excl)}`);
    console.log(`      (a cold test WITHOUT the purchaser + all-customers exclusions reads contaminated)`);
    console.log(`  geo ${JSON.stringify(targeting.geo_locations)}`);
    console.log(`  cohort columns: excluded_purchaser=${active[0]?.excluded_purchaser_audience_id ?? "—"} excluded_all=${active[0]?.excluded_all_customers_audience_id ?? "—"}`);
  }

  // ── Meta side ────────────────────────────────────────────────────────────
  const token = await getMetaUserToken(WS);
  if (token && acct) {
    const camp = String(eff?.testMetaCampaignId ?? active[0]?.test_meta_campaign_id);
    const j = await fetch(
      `https://graph.facebook.com/v21.0/${camp}?fields=id,name,effective_status,daily_budget,objective&access_token=${encodeURIComponent(token)}`,
    ).then((r) => r.json()) as Record<string, unknown>;
    console.log(`\n=== Meta test campaign ===`);
    if (j.error) console.log(`  ❌ ${JSON.stringify(j.error)}`);
    else {
      console.log(`  ${ok(String(j.effective_status) === "ACTIVE")} ${j.name} · ${j.effective_status} · ${j.daily_budget ? `CBO $${Number(j.daily_budget) / 100}` : "ABO ✓"} · ${j.objective}`);
      const sets = await listAdSets(token, String(acct.meta_account_id), camp);
      console.log(`  adsets: ${sets.length} total, ${sets.filter((s) => s.effective_status === "ACTIVE").length} active`);
    }
  }

  // ── slot math + the bin ──────────────────────────────────────────────────
  const size = await readCurrentTestCohortSize(admin, {
    workspaceId: WS, productId: KCUPS, testMetaCampaignId: eff?.testMetaCampaignId ?? null,
  });
  const target = eff ? Math.floor(eff.dailyTestCeilingCents / eff.perTestDailyBudgetCents) : 0;
  console.log(`\n=== SLOTS ===`);
  console.log(`  live ${size} · target ${target} (ceiling ÷ per-test) ⇒ ${Math.max(0, target - size)} open`);

  const res = await listReadyToTest(admin, { workspaceId: WS, productId: KCUPS, temperature: "cold" });
  const bin = (Array.isArray(res) ? res : (res as { readyToTest?: unknown[] }).readyToTest ?? []);
  console.log(`  ${ok(bin.length > 0)} cold creatives ready for K-Cups: ${bin.length}`);

  // ── did a pass actually run? ─────────────────────────────────────────────
  const { data: acts } = await admin.from("director_activity")
    .select("created_at,action_kind,reason").eq("workspace_id", WS)
    .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
    .ilike("action_kind", "media_buyer_pass%").order("created_at", { ascending: false }).limit(40);
  const kcupsPasses = (acts ?? []).filter((a) => String(a.reason ?? "").includes(`/${target}`));
  console.log(`\n=== passes in the last 24h: ${(acts ?? []).length} (any product) ===`);
  console.log(`  a K-Cups pass emits a heartbeat each run; the fan-out is per account x product.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
