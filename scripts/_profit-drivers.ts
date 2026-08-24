/**
 * Re-run the profit-driver analysis behind docs/brain/functions/cfo/profit-drivers.md.
 *
 * READ-ONLY. DB-only — ZERO external API calls. Appstle bills per hit and must
 * never be bulk-looped; our own tables already mirror the state we need.
 *
 *   npx tsx scripts/_profit-drivers.ts
 *
 * Method notes that are easy to get wrong (all learned the hard way — see the
 * brain page's "How to re-run"):
 *   - EXCLUDE 2024-12 from correlations: an inventory write-off puts COGS at
 *     143% of income and swamps every coefficient.
 *   - Cohort dedupe needs a LONG lookback. Deduping inside the reporting window
 *     counts returning buyers as new (inflated July first-order AOV $102 -> $115).
 *   - Control for day-of-week on spend-response reads; a naive low/high split
 *     compares weekend-heavy to weekday-only periods.
 *   - Page every daily-table read past the 1000-row cap; a single ranged select
 *     silently truncates.
 */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
/** The inventory-write-off month that distorts every correlation. */
const OUTLIER_MONTHS = new Set(["2024-12"]);
/** Ad-load threshold that separates the two profit regimes. */
const HIGH_AD_LOAD = 0.25;

const K = (v: number) => (v < 0 ? "-" : "") + "$" + Math.abs(v / 1000).toFixed(0) + "K";
const pc = (v: number) => (v * 100).toFixed(1) + "%";

function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return sx && sy ? cov / (sx * sy) : NaN;
}

async function pageDaily(
  admin: ReturnType<typeof createAdminClient>,
  table: string, cols: string[], from: string, to: string,
): Promise<Record<string, number>> {
  const acc: Record<string, number> = {};
  for (const c of cols) acc[c] = 0;
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols.join(","))
      .eq("workspace_id", WS).gte("snapshot_date", from).lte("snapshot_date", to).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of (data ?? []) as unknown as Record<string, number>[]) {
      for (const c of cols) acc[c] += Number(r[c] ?? 0);
    }
    if (!data || data.length < 1000) break;
  }
  return acc;
}

async function main() {
  const admin = createAdminClient();

  // ── 1. P&L series ────────────────────────────────────────────────────────
  const { data: pnl, error } = await admin.from("qb_pnl_snapshots")
    .select("period_month,total_income,total_cogs,gross_profit,adjusted_net_income,net_income,management_fees,digital_advertising,transaction_fees,fixed_opex")
    .eq("workspace_id", WS).order("period_month", { ascending: true });
  if (error) throw new Error(`qb_pnl_snapshots: ${error.message}`);

  const all = (pnl ?? []).map((r) => ({
    m: String(r.period_month).slice(0, 7),
    income: Number(r.total_income ?? 0),
    cogs: Number(r.total_cogs ?? 0),
    gp: Number(r.gross_profit ?? 0),
    ads: Number(r.digital_advertising ?? 0),
    txn: Number(r.transaction_fees ?? 0),
    fixed: Number(r.fixed_opex ?? 0),
    profit: Number(r.adjusted_net_income ?? 0),
  })).filter((r) => r.income > 0);

  console.log("╔═ P&L SERIES ═══════════════════════════════════════════════════════════════");
  console.log("month     income    COGS%    ADS   ads%inc   fixedOpex   REAL PROFIT   margin");
  for (const r of all) {
    const flag = OUTLIER_MONTHS.has(r.m) ? "  ← OUTLIER (excluded)" : "";
    console.log(
      `${r.m}  ${K(r.income).padStart(7)}  ${pc(r.cogs / r.income).padStart(6)} ${K(r.ads).padStart(6)}  ${pc(r.ads / r.income).padStart(6)}   ${K(r.fixed).padStart(7)}   ${K(r.profit).padStart(9)}   ${pc(r.profit / r.income).padStart(6)}${flag}`
    );
  }

  // ── 2. The two regimes ───────────────────────────────────────────────────
  const clean = all.filter((r) => !OUTLIER_MONTHS.has(r.m));
  const hi = clean.filter((r) => r.ads / r.income > HIGH_AD_LOAD);
  const lo = clean.filter((r) => r.ads / r.income <= HIGH_AD_LOAD);
  const avg = (a: typeof clean, f: (r: typeof clean[0]) => number) =>
    a.length ? a.reduce((s, r) => s + f(r), 0) / a.length : 0;

  console.log("\n╔═ THE TWO REGIMES ══════════════════════════════════════════════════════════");
  for (const [label, set] of [[`ads >${HIGH_AD_LOAD * 100}% of income`, hi], [`ads <=${HIGH_AD_LOAD * 100}%`, lo]] as const) {
    console.log(
      `  ${label.padEnd(26)} n=${String(set.length).padStart(2)}   income ${K(avg(set, (r) => r.income)).padStart(7)}   ads ${K(avg(set, (r) => r.ads)).padStart(6)}   PROFIT ${K(avg(set, (r) => r.profit)).padStart(7)}   margin ${pc(avg(set, (r) => r.profit) / Math.max(avg(set, (r) => r.income), 1))}`
    );
  }

  // ── 3. Correlations ──────────────────────────────────────────────────────
  console.log(`\n╔═ CORRELATION WITH REAL PROFIT (n=${clean.length}, outlier excluded) ══════════`);
  const p = clean.map((r) => r.profit);
  const pairs: Array<[string, number[]]> = [
    ["ads as % of income", clean.map((r) => r.ads / r.income)],
    ["gross profit $", clean.map((r) => r.gp)],
    ["digital ads $", clean.map((r) => r.ads)],
    ["gross margin %", clean.map((r) => r.gp / r.income)],
    ["income", clean.map((r) => r.income)],
    ["fixed opex $", clean.map((r) => r.fixed)],
  ];
  for (const [name, xs] of pairs.sort((a, b) => Math.abs(corr(b[1], p)) - Math.abs(corr(a[1], p)))) {
    console.log(`  ${name.padEnd(22)} r = ${corr(xs, p).toFixed(2)}`);
  }

  // ── 4. Fixed OpEx by half-year ───────────────────────────────────────────
  console.log("\n╔═ FIXED OPEX BY HALF-YEAR (is G&A still flat?) ═════════════════════════════");
  const halves: Record<string, number[]> = {};
  for (const r of all) {
    const h = `${r.m.slice(0, 4)}-H${Number(r.m.slice(5, 7)) <= 6 ? 1 : 2}`;
    (halves[h] ??= []).push(r.fixed);
  }
  for (const [h, v] of Object.entries(halves).sort()) {
    console.log(`  ${h}   avg ${K(v.reduce((a, b) => a + b, 0) / v.length).padStart(7)}   (n=${v.length})`);
  }

  // ── 5. Current unit economics + breakeven ────────────────────────────────
  const latest = all[all.length - 1];
  if (latest) {
    const gm = 1 - latest.cogs / latest.income;
    const txnR = latest.txn / latest.income;
    const breakeven = (latest.ads + latest.fixed) / Math.max(gm - txnR, 0.0001);
    console.log(`\n╔═ UNIT ECONOMICS — ${latest.m} (latest closed month) ═══════════════════════`);
    console.log(`  income ${K(latest.income)}   gross margin ${pc(gm)}   txn ${pc(txnR)}   ads ${K(latest.ads)}   fixed ${K(latest.fixed)}`);
    console.log(`  REAL PROFIT ${K(latest.profit)}  (margin ${pc(latest.profit / latest.income)})`);
    console.log(`  BREAKEVEN income at this cost structure: ${K(breakeven)}/mo   → headroom ${K(latest.income - breakeven)}`);
  }

  // ── 6. Cohorts — retention shape + first-order AOV ───────────────────────
  console.log("\n╔═ COHORTS (long lookback — do NOT dedupe inside the window) ════════════════");
  const { data: ws } = await admin.from("workspaces").select("order_source_mapping").eq("id", WS).single();
  const sm = (ws?.order_source_mapping ?? {}) as Record<string, string>;

  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error: e2 } = await admin.from("orders")
      .select("customer_id,created_at,total_cents,source_name,tags,subscription_id,line_items")
      .eq("workspace_id", WS).gte("created_at", "2025-09-01T00:00:00Z")
      .order("created_at", { ascending: true }).range(off, off + 999);
    if (e2) throw new Error(`orders: ${e2.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const first = new Map<string, number>();
  for (const r of rows) {
    const cid = r.customer_id as string | null;
    if (!cid) continue;
    const b = bucketOrder(r as never, sm);
    if (b !== "new_sub" && b !== "one_time") continue;
    const t = Date.parse(String(r.created_at));
    if (!first.has(cid) || t < first.get(cid)!) first.set(cid, t);
  }
  const nowMs = Date.now();
  type C = { n: number; rev: number[]; m1: Set<string>; firstRev: number; units: number };
  const coh: Record<string, C> = {};
  const ensure = (m: string) => (coh[m] ??= { n: 0, rev: Array(5).fill(0), m1: new Set(), firstRev: 0, units: 0 });
  for (const [, acq] of first) ensure(new Date(acq).toISOString().slice(0, 7)).n++;
  for (const r of rows) {
    const cid = r.customer_id as string | null;
    if (!cid) continue;
    const acq = first.get(cid);
    if (acq == null) continue;
    const t = Date.parse(String(r.created_at));
    if (t < acq) continue;
    const c = ensure(new Date(acq).toISOString().slice(0, 7));
    const mi = Math.floor((t - acq) / (30.44 * 86400000));
    if (mi < 5) c.rev[mi] += Number(r.total_cents ?? 0);
    if (mi === 1) c.m1.add(cid);
    if (t === acq) {
      c.firstRev += Number(r.total_cents ?? 0);
      for (const li of (Array.isArray(r.line_items) ? r.line_items : []) as Array<Record<string, unknown>>) {
        c.units += Number(li.quantity ?? 1);
      }
    }
  }
  console.log("cohort     n   1st-AOV  units   m1 ret   m1 mult   cum m0-m3");
  for (const m of Object.keys(coh).sort()) {
    const c = coh[m];
    if (c.n < 60) continue;
    const ageM = (nowMs - Date.parse(`${m}-28T00:00:00Z`)) / (30.44 * 86400000);
    const m1ret = ageM >= 2 ? ((c.m1.size / c.n) * 100).toFixed(0) + "%" : "  —";
    const m1mult = ageM >= 2 ? (c.rev[1] / Math.max(c.rev[0], 1)).toFixed(2) : "   —";
    const cum = ageM >= 4 ? "$" + (c.rev.slice(0, 4).reduce((a, b) => a + b, 0) / c.n / 100).toFixed(0) : "(immature)";
    console.log(
      `${m}  ${String(c.n).padStart(4)}   $${(c.firstRev / c.n / 100).toFixed(0).padStart(4)}   ${(c.units / c.n).toFixed(2)}    ${m1ret.padStart(5)}     ${m1mult.padStart(5)}   ${cum.padStart(10)}`
    );
  }

  const mature = Object.entries(coh).filter(([m, c]) =>
    c.n >= 100 && (nowMs - Date.parse(`${m}-28T00:00:00Z`)) / (30.44 * 86400000) >= 4);
  if (mature.length >= 3) {
    console.log("\n  RETENTION-SHAPE STABILITY (is churn still structural?)");
    for (const idx of [1, 2, 3]) {
      const vals = mature.map(([, c]) => c.rev[idx] / Math.max(c.rev[0], 1));
      const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length);
      console.log(`    month ${idx}:  mean ${mu.toFixed(3)}   spread ${(sd / mu * 100).toFixed(1)}%  ${(sd / mu) < 0.25 ? "→ STRUCTURAL" : "→ MOVED, investigate"}`);
    }
  }

  console.log("\nFull write-up + findings log: docs/brain/functions/cfo/profit-drivers.md");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
