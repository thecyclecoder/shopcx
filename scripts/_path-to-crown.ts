/**
 * For each LIVE Superfood Tabs test adset: what would it actually take to crown?
 *
 * Two independent ways to clear the bound `cpa * exp(z/sqrt(n)) <= crownMaxCpa`:
 *   - hold the current CPA and accumulate more purchases (the bound tightens with n), or
 *   - improve CPA at the current n.
 * Reports the required n at today's CPA, and the required CPA at n=15 / n=25.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { crownUpperBoundCpaCents, CROWN_CONFIDENCE_Z } from "../src/lib/media-buyer/meta-cpa-signal";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_CAMPAIGN = "120250066504550326";
const PER_TEST_DAILY = 20000; // $200/day, post-hotfix
const $ = (c: number) => "$" + (c / 100).toFixed(0);

/** Smallest n at which `cpa` clears the crown bound (null if it never does). */
function nNeeded(cpaCents: number, crownMax: number, z = CROWN_CONFIDENCE_Z): number | null {
  if (cpaCents > crownMax) return null; // the point estimate is already over — more data cannot fix it
  for (let n = 1; n <= 2000; n++) if (crownUpperBoundCpaCents(cpaCents, n, z) <= crownMax) return n;
  return null;
}
/** CPA that would clear the bound at exactly n purchases. */
const cpaNeededAt = (n: number, crownMax: number, z = CROWN_CONFIDENCE_Z) => crownMax / Math.exp(z / Math.sqrt(n));

async function main() {
  const admin = createAdminClient();
  const { data: pol } = await admin.from("iteration_policies")
    .select("crown_max_cpa_cents,crown_min_purchases").eq("workspace_id", WS).eq("status", "active").limit(1).maybeSingle();
  const crownMax = Number(pol?.crown_max_cpa_cents);
  const minN = Number(pol?.crown_min_purchases);

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

  const { data: adsets } = await admin.from("meta_adsets")
    .select("meta_adset_id,name,effective_status").eq("workspace_id", WS)
    .eq("meta_campaign_id", TABS_CAMPAIGN);

  console.log(`crown ≤ ${$(crownMax)} · min purchases ${minN} · z ${CROWN_CONFIDENCE_Z}`);
  console.log(`floor CPA to EVER crown: ${$(cpaNeededAt(minN, crownMax))} at n=${minN} · ${$(cpaNeededAt(25, crownMax))} at n=25 · ${$(cpaNeededAt(40, crownMax))} at n=40\n`);

  for (const a of adsets ?? []) {
    if (String(a.effective_status) !== "ACTIVE") continue;
    const m = life[String(a.meta_adset_id)] ?? { s: 0, p: 0 };
    const cpa = m.p ? m.s / m.p : Number.POSITIVE_INFINITY;
    console.log(`${String(a.name).slice(0, 48)}`);
    console.log(`   lifetime ${$(m.s)} · ${m.p} purchases · CPA ${m.p ? $(cpa) : "—"} · bound ${m.p ? $(crownUpperBoundCpaCents(cpa, m.p)) : "—"}`);
    if (!m.p) { console.log(`   ⇒ no purchases — nothing to project\n`); continue; }

    const need = nNeeded(cpa, crownMax);
    if (need === null) {
      console.log(`   ⇒ ❌ CPA ${$(cpa)} is ALREADY above the ${$(crownMax)} crown line.`);
      console.log(`      More data cannot rescue it — the point estimate itself fails. It needs to get BETTER, not bigger.`);
      console.log(`      To crown at its current ${m.p} purchases it would need CPA ≤ ${$(cpaNeededAt(m.p, crownMax))}.\n`);
      continue;
    }
    const extra = Math.max(0, need - m.p);
    const daysAtBudget = extra > 0 ? (extra * cpa) / PER_TEST_DAILY : 0;
    console.log(`   ⇒ holding ${$(cpa)}, it crowns at n=${need} — ${extra} more purchase(s), ~${daysAtBudget.toFixed(0)} days at $${PER_TEST_DAILY / 100}/day`);
    console.log(`      or crown sooner by improving CPA: ≤ ${$(cpaNeededAt(Math.max(minN, m.p), crownMax))} at n=${Math.max(minN, m.p)}\n`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
