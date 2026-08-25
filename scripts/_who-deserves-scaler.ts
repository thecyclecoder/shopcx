/**
 * Is there legitimately an ad that should be in the scaler and out of the test lane?
 *
 * Runs the REAL crown detector (`detectMetaCpaWinners`) with the live policy values, then shows the
 * per-adset arithmetic so the verdict is inspectable rather than a yes/no. Lifetime metrics, which
 * is what the detector uses — not a hand-picked window.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { detectMetaCpaWinners, crownUpperBoundCpaCents, CROWN_CONFIDENCE_Z } from "../src/lib/media-buyer/meta-cpa-signal";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();

  const { data: pol } = await admin.from("iteration_policies")
    .select("crown_max_cpa_cents,crown_min_spend_cents,crown_min_purchases")
    .eq("workspace_id", WS).eq("status", "active").limit(1).maybeSingle();
  const crownMaxCpaCents = Number(pol?.crown_max_cpa_cents);
  const crownMinSpendCents = Number(pol?.crown_min_spend_cents);
  const crownMinPurchases = Number(pol?.crown_min_purchases);
  console.log(`LIVE POLICY: crown ≤ ${$(crownMaxCpaCents)} CPA · spend ≥ ${$(crownMinSpendCents)} · purchases ≥ ${crownMinPurchases} · z=${CROWN_CONFIDENCE_Z}\n`);

  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_name").eq("workspace_id", WS);

  // Lifetime per-adset metrics, same grain the detector reads.
  const rows: Array<{ meta_object_id: string; spend_cents: number; purchases: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("meta_insights_daily")
      .select("meta_object_id,spend_cents,purchases").eq("workspace_id", WS).eq("level", "adset")
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const life: Record<string, { s: number; p: number }> = {};
  for (const r of rows) {
    const k = String(r.meta_object_id);
    life[k] ??= { s: 0, p: 0 };
    life[k].s += Number(r.spend_cents ?? 0);
    life[k].p += Number(r.purchases ?? 0);
  }

  // Scope to the Superfood Tabs test campaign.
  const TABS_CAMPAIGN = "120250066504550326";
  const { data: adsets } = await admin.from("meta_adsets")
    .select("meta_adset_id,name,effective_status").eq("workspace_id", WS).eq("meta_campaign_id", TABS_CAMPAIGN);

  console.log("=== SUPERFOOD TABS TEST ADSETS — lifetime, against the NEW rule ===");
  console.log("  adset                                   status    spend  purch     CPA   pess. bound   crowns?");
  for (const a of (adsets ?? []).sort((x, y) => (life[String(y.meta_adset_id)]?.p ?? 0) - (life[String(x.meta_adset_id)]?.p ?? 0))) {
    const id = String(a.meta_adset_id);
    const m = life[id] ?? { s: 0, p: 0 };
    if (m.s === 0) continue;
    const cpa = m.p ? m.s / m.p : Number.POSITIVE_INFINITY;
    const bound = crownUpperBoundCpaCents(cpa, m.p);
    const passN = m.p >= crownMinPurchases;
    const passSpend = m.s >= crownMinSpendCents;
    const passBound = bound <= crownMaxCpaCents;
    const verdict = passN && passSpend && passBound
      ? "✅ CROWN"
      : !passN ? `no — only ${m.p}/${crownMinPurchases} purchases`
      : !passSpend ? "no — under spend floor"
      : `no — bound ${$(bound)} > ${$(crownMaxCpaCents)}`;
    console.log(
      `  ${String(a.name).slice(0, 38).padEnd(38)} ${String(a.effective_status ?? "?").slice(0, 8).padEnd(8)} ${$(m.s).padStart(6)}  ${String(m.p).padStart(5)}  ${(m.p ? $(cpa) : "—").padStart(6)}  ${(Number.isFinite(bound) ? $(bound) : "—").padStart(11)}   ${verdict}`,
    );
  }

  // The real detector, per account.
  console.log("\n=== detectMetaCpaWinners — the ACTUAL detector, live policy ===");
  for (const a of accts ?? []) {
    const winners = await detectMetaCpaWinners(admin, {
      workspaceId: WS,
      metaAdAccountId: String(a.id),
      crownMaxCpaCents,
      crownMinSpendCents,
      crownMinPurchases,
    });
    console.log(`  ${String(a.meta_account_name).padEnd(26)} ${winners.length} qualifying winner(s)`);
    for (const w of winners) console.log(`      ad ${w.metaAdId} · spend ${$(w.spendCents)} · roas ${w.roas}`);
  }

  console.log("\n=== WOULD THE OLD RULE HAVE CROWNED ANY OF THESE? ===");
  for (const a of accts ?? []) {
    const old = await detectMetaCpaWinners(admin, {
      workspaceId: WS,
      metaAdAccountId: String(a.id),
      crownMaxCpaCents,
      crownMinSpendCents,
      crownMinPurchases: 8,
      crownConfidenceZ: 0, // point estimate, the pre-2026-08-25 rule
    });
    console.log(`  ${String(a.meta_account_name).padEnd(26)} ${old.length} would have crowned under the OLD rule`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
