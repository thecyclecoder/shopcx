/**
 * CEO 2026-08-25 — two live actions after the crown-rule change.
 *
 * 1. REVOKE every crown marker that no longer qualifies under the LIVE policy. All 5 were crowned
 *    under the old point-estimate rule at n=8; `detectMetaCpaWinners` now returns 0 winners across
 *    all four ad accounts. Left in place they still drive behaviour: `exploitDeficit = 2` would
 *    spawn amplifyWinner CLONES off adsets that never earned it (one is at $245 lifetime CPA).
 *    Revocation = `markExploitExhausted` — the winner drops out of `listActiveWinnersForProduct`,
 *    the explore target reverts to the full cohort target, and the crown HISTORY is preserved.
 *
 * 2. DE-SCALE `MB Tabs · skeptic-bloat` $1,337/day -> $200/day (the new per-test budget).
 *    It has 26 purchases — past the 15 bar, so not a sample-size problem — at $245 lifetime CPA,
 *    already over the $240 crown line. It was $158 CPA on 11 purchases BEFORE being scaled. Putting
 *    it back on a test budget is the cleanest available test of whether the scaling caused the
 *    degradation; pausing it would throw that information away.
 *
 * Verifies each crown against the live policy before revoking — never revokes one that still earns
 * its crown. IDEMPOTENT. Pass --apply to write; default is a dry run.
 */
import { createAdminClient } from "./_bootstrap";
import { markExploitExhausted } from "../src/lib/media-buyer/crowned-winners";
import { crownUpperBoundCpaCents } from "../src/lib/media-buyer/meta-cpa-signal";
import { getMetaUserToken, updateObjectBudget } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

const SKEPTIC_BLOAT_ADSET = "120250143054030326";
const NEW_BUDGET_CENTS = 20000;
const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();

  const { data: pol } = await admin.from("iteration_policies")
    .select("crown_max_cpa_cents,crown_min_spend_cents,crown_min_purchases")
    .eq("workspace_id", WS).eq("status", "active").limit(1).maybeSingle();
  const crownMax = Number(pol?.crown_max_cpa_cents);
  const minSpend = Number(pol?.crown_min_spend_cents);
  const minN = Number(pol?.crown_min_purchases);
  console.log(`LIVE POLICY: crown ≤ ${$(crownMax)} · spend ≥ ${$(minSpend)} · purchases ≥ ${minN}\n`);

  // Lifetime per-adset metrics.
  const rows: Array<{ meta_object_id: string; spend_cents: number; purchases: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data } = await admin.from("meta_insights_daily")
      .select("meta_object_id,spend_cents,purchases").eq("workspace_id", WS).eq("level", "adset").range(off, off + 999);
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

  // ── 1. revoke stale crowns ───────────────────────────────────────────────
  const { data: winners, error } = await admin.from("media_buyer_crowned_winners")
    .select("test_meta_adset_id,product_id,exploit_exhausted,created_at").eq("workspace_id", WS);
  if (error) throw new Error(error.message);

  console.log("=== CROWN MARKERS vs the live policy ===");
  const toRevoke: string[] = [];
  for (const w of winners ?? []) {
    const id = String(w.test_meta_adset_id);
    const m = life[id] ?? { s: 0, p: 0 };
    const cpa = m.p ? m.s / m.p : Number.POSITIVE_INFINITY;
    const bound = crownUpperBoundCpaCents(cpa, m.p);
    const stillQualifies = m.p >= minN && m.s >= minSpend && bound <= crownMax;

    if (w.exploit_exhausted) {
      console.log(`  ${id.slice(-10)}  already revoked — no-op`);
      continue;
    }
    if (stillQualifies) {
      console.log(`  ${id.slice(-10)}  ✅ STILL EARNS ITS CROWN (${m.p}p, CPA ${$(cpa)}, bound ${$(bound)}) — KEEPING`);
      continue;
    }
    const why = m.p < minN ? `only ${m.p}/${minN} purchases`
      : m.s < minSpend ? "under the spend floor"
      : `bound ${$(bound)} > ${$(crownMax)}`;
    console.log(`  ${id.slice(-10)}  ✗ revoke — ${why} (${m.p}p, CPA ${m.p ? $(cpa) : "—"})`);
    toRevoke.push(id);
  }

  if (APPLY) {
    for (const id of toRevoke) {
      await markExploitExhausted(admin, { workspaceId: WS, testMetaAdsetId: id });
      console.log(`  ✅ revoked ${id}`);
    }
  }

  // ── 2. de-scale skeptic-bloat ────────────────────────────────────────────
  console.log(`\n=== DE-SCALE skeptic-bloat ===`);
  const { data: asRow } = await admin.from("meta_adsets")
    .select("meta_adset_id,name,daily_budget_cents").eq("workspace_id", WS)
    .eq("meta_adset_id", SKEPTIC_BLOAT_ADSET).maybeSingle();
  const cur = Number(asRow?.daily_budget_cents ?? 0);
  console.log(`  ${asRow?.name ?? SKEPTIC_BLOAT_ADSET}`);
  console.log(`  current ${$(cur)}/day → target ${$(NEW_BUDGET_CENTS)}/day`);

  if (cur === NEW_BUDGET_CENTS) {
    console.log("  already at target — no-op");
  } else if (APPLY) {
    const token = await getMetaUserToken(WS);
    if (!token) throw new Error("no Meta token");
    await updateObjectBudget(token, SKEPTIC_BLOAT_ADSET, { dailyBudgetCents: NEW_BUDGET_CENTS });
    console.log(`  ✅ Meta budget set to ${$(NEW_BUDGET_CENTS)}/day (frees ${$(cur - NEW_BUDGET_CENTS)}/day)`);
  }

  // ── audit ────────────────────────────────────────────────────────────────
  if (APPLY && (toRevoke.length || cur !== NEW_BUDGET_CENTS)) {
    const { error: ae } = await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "growth",
      action_kind: "media_buyer_stale_crowns_revoked",
      reason:
        `CEO 2026-08-25: revoked ${toRevoke.length} crown marker(s) that no longer qualify under the live policy ` +
        `(crown ≤ ${$(crownMax)}, ≥ ${minN} purchases, confidence-bounded) — all were crowned under the old ` +
        `point-estimate rule at n=8, and detectMetaCpaWinners now returns 0 winners across all 4 accounts. Left in ` +
        `place they would spawn amplifyWinner clones off adsets that never earned it. Also de-scaled skeptic-bloat ` +
        `${$(cur)} → ${$(NEW_BUDGET_CENTS)}/day: 26 purchases (past the bar) at ${$(24500)} lifetime CPA, vs $158 on ` +
        `11 purchases before it was scaled — back on a test budget to see whether the scaling caused the degradation.`,
      metadata: { revoked: toRevoke, skeptic_bloat_budget: { from: cur, to: NEW_BUDGET_CENTS }, autonomous: false },
    });
    if (ae) console.log(`  ⚠ audit row failed: ${ae.message}`);
    else console.log("  ✅ director_activity audit row written");
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (pass --apply)"}: ${toRevoke.length} crown(s) to revoke · budget ${cur === NEW_BUDGET_CENTS ? "already set" : `${$(cur)} → ${$(NEW_BUDGET_CENTS)}`}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
