/**
 * Two questions, answered from live state:
 *   1. Does the DB point Bianca at the NEW ABO scalers (and only those)?
 *   2. Are the OLD CBO scaler campaigns actually paused in Meta?
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { listActiveColdScalerCohorts } from "../src/lib/media-buyer/cold-scaler-cohort";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const LEGACY = ["120249609991450682", "120250620926360326"];

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  // 1. What Bianca's own reader returns. NB: the reader is ACCOUNT-SCOPED — it filters on
  // metaAdAccountId, so it must be called once per account. Calling it without one matches nothing.
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_name").eq("workspace_id", WS);
  const active: Array<{ productId: string | null; scalerMetaCampaignId: string | null; id: string }> = [];
  console.log(`=== 1. WHAT BIANCA READS (listActiveColdScalerCohorts, per account) ===`);
  for (const a of accts ?? []) {
    const rows = await listActiveColdScalerCohorts(admin, { workspaceId: WS, metaAdAccountId: String(a.id) });
    console.log(`  ${String(a.meta_account_name)} — ${rows.length} cohort(s)`);
    for (const c of rows) {
      console.log(`     ${String(title.get(String(c.productId)) ?? c.productId).padEnd(24)} campaign ${c.scalerMetaCampaignId ?? "⚠ UNSTAMPED"}  cohort ${String(c.id).slice(0, 8)}`);
      active.push({ productId: c.productId, scalerMetaCampaignId: c.scalerMetaCampaignId, id: c.id });
    }
  }
  console.log(`  total visible to Bianca: ${active.length}`);
  const unstamped = active.filter((c) => !c.scalerMetaCampaignId);
  console.log(`  ${unstamped.length === 0 ? "✅ every active cohort is stamped with a campaign" : `❌ ${unstamped.length} unstamped`}`);
  const pointsAtLegacy = active.filter((c) => LEGACY.includes(String(c.scalerMetaCampaignId)));
  console.log(`  ${pointsAtLegacy.length === 0 ? "✅ none still point at a legacy CBO campaign" : `❌ ${pointsAtLegacy.length} still point at a legacy CBO campaign`}`);

  // 2. Every cohort row ever, so retired ones are visible.
  const { data: all } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id,product_id,scaler_meta_campaign_id,is_active,updated_at").eq("workspace_id", WS)
    .order("is_active", { ascending: false });
  console.log(`\n=== ALL cold-scaler cohort rows (${(all ?? []).length}) ===`);
  for (const c of all ?? []) {
    console.log(`  ${c.is_active ? "ACTIVE  " : "retired "} ${String(title.get(String(c.product_id)) ?? "—").padEnd(24)} camp ${c.scaler_meta_campaign_id ?? "—"}  ${String(c.id).slice(0, 8)}`);
  }

  // 3. Legacy campaigns in Meta.
  console.log(`\n=== 2. LEGACY CBO CAMPAIGNS IN META ===`);
  for (const id of LEGACY) {
    const j = await fetch(
      `https://graph.facebook.com/v21.0/${id}?fields=id,name,effective_status,daily_budget&access_token=${encodeURIComponent(token)}`,
    ).then((r) => r.json()) as Record<string, unknown>;
    if (j.error) { console.log(`  ${id}: ${JSON.stringify(j.error)}`); continue; }
    const paused = String(j.effective_status) === "PAUSED";
    console.log(`  ${paused ? "✅" : "❌"} ${String(j.name)}`);
    console.log(`       ${j.effective_status} · ${j.daily_budget ? `CBO $${(Number(j.daily_budget) / 100).toFixed(0)}/day (budget still set, but PAUSED cannot spend)` : "no budget"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
