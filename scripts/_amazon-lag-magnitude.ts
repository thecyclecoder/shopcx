/**
 * HOW BIG is the delayed Amazon response, and what does it do to the Aug-18 ramp's marginal CAC?
 *
 * _amazon-lag-direction.ts established the response is real and asymmetric (spend leads),
 * peaking ~12 days out at 21-day smoothing. This puts a number on it:
 *
 *   slope = extra Amazon orders/day per +$1,000/day of sustained spend, at the peak lag
 *
 * with a MOVING-BLOCK BOOTSTRAP confidence interval (resampling 42-day blocks, so the CI
 * respects the autocorrelation instead of pretending 600 days are 600 independent draws).
 *
 * Then applies it to the Aug 18-24 ramp to ask the decision question: was yesterday's $452
 * marginal CAC measured too early to see Amazon?
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const WIDTH = 21;      // where the response is visible (see _amazon-lag-timescale.ts)
const TREND = 105;     // 5x width
const BLOCK = 42;      // bootstrap block length — 2x the smoothing width
const DRAWS = 2000;
const LTV = 208.93;
const CONTRIB = 0.663;

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function ols(x: number[], y: number[]) {
  const mx = mean(x), my = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  return den ? num / den : NaN;
}

function smooth(x: number[], w: number): Array<number | null> {
  return x.map((_, i) => {
    if (i < w - 1) return null;
    let s = 0; for (let j = i - w + 1; j <= i; j++) s += x[j];
    return s / w;
  });
}

function detrend(x: Array<number | null>, w: number): Array<number | null> {
  const h = Math.floor((w - 1) / 2);
  const t = x.map((_, i) => {
    if (i < h || i >= x.length - h) return null;
    let s = 0, n = 0;
    for (let j = i - h; j <= i + h; j++) { const v = x[j]; if (v === null) return null; s += v; n++; }
    return s / n;
  });
  return x.map((v, i) => (v === null || t[i] === null ? null : v - (t[i] as number)));
}

async function pageAll(admin: ReturnType<typeof createAdminClient>, table: string, cols: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols).eq("workspace_id", WS).order("snapshot_date").range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();
  const [sp, si, az] = await Promise.all([
    pageAll(admin, "daily_meta_ad_spend", "snapshot_date,spend_cents"),
    pageAll(admin, "daily_order_snapshots", "snapshot_date,new_subscription_count,one_time_count"),
    pageAll(admin, "daily_amazon_order_snapshots", "snapshot_date,order_bucket,order_count"),
  ]);
  const S: Record<string, number> = {}, W: Record<string, number> = {}, A: Record<string, number> = {};
  for (const r of sp) { const d = String(r.snapshot_date); S[d] = (S[d] ?? 0) + Number(r.spend_cents ?? 0) / 100; }
  for (const r of si) { const d = String(r.snapshot_date); W[d] = (W[d] ?? 0) + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0); }
  for (const r of az) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    const d = String(r.snapshot_date); A[d] = (A[d] ?? 0) + Number(r.order_count ?? 0);
  }
  const all = [...new Set([...Object.keys(S), ...Object.keys(W), ...Object.keys(A)])].sort();
  const dates: string[] = [];
  for (let t = Date.parse(`${all[0]}T12:00:00Z`); t <= Date.parse(`${all[all.length - 2]}T12:00:00Z`); t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const sv = dates.map((d) => S[d] ?? 0), wv = dates.map((d) => W[d] ?? 0), av = dates.map((d) => A[d] ?? 0);

  const ss = detrend(smooth(sv, WIDTH), TREND);
  const aa = detrend(smooth(av, WIDTH), TREND);
  const ww = detrend(smooth(wv, WIDTH), TREND);

  const pairsAt = (target: Array<number | null>, k: number) => {
    const x: number[] = [], y: number[] = [];
    for (let i = k; i < dates.length; i++) {
      const t = target[i], d = ss[i - k];
      if (t == null || d == null) continue;
      x.push(d); y.push(t);
    }
    return { x, y };
  };

  console.log("=== SLOPE BY LAG (Amazon orders/day per +$1,000/day sustained) ===");
  let best = { k: 0, b: -Infinity };
  for (let k = 0; k <= 28; k += 2) {
    const { x, y } = pairsAt(aa, k);
    const b = ols(x, y) * 1000;
    if (b > best.b) best = { k, b };
    console.log(`  lag ${String(k).padStart(2)}   ${b.toFixed(2).padStart(6)} orders per $1k/day   ${"▇".repeat(Math.max(0, Math.round(b * 4)))}`);
  }
  const wb = ols(pairsAt(ww, 0).x, pairsAt(ww, 0).y) * 1000;
  console.log(`\n  website at lag 0: ${wb.toFixed(2)} orders per $1k/day (the immediate response)`);
  console.log(`  Amazon peak:      ${best.b.toFixed(2)} orders per $1k/day at lag ${best.k}`);

  // ── moving-block bootstrap CI on the peak-lag slope ───────────────────────
  const { x, y } = pairsAt(aa, best.k);
  const nBlocks = Math.floor(x.length / BLOCK);
  const boot: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const bx: number[] = [], by: number[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const st = Math.floor(Math.random() * (x.length - BLOCK));
      for (let i = st; i < st + BLOCK; i++) { bx.push(x[i]); by.push(y[i]); }
    }
    boot.push(ols(bx, by) * 1000);
  }
  boot.sort((p, q) => p - q);
  const lo = boot[Math.floor(0.025 * DRAWS)], hi = boot[Math.floor(0.975 * DRAWS)];
  console.log(`  95% CI (moving-block bootstrap, ${BLOCK}-day blocks): ${lo.toFixed(2)} … ${hi.toFixed(2)}`);
  console.log(`  ► ${lo > 0 ? "CI excludes zero — the delayed response is real" : "CI INCLUDES ZERO — cannot rule out no effect"}`);

  // ── what it means for the Aug ramp ────────────────────────────────────────
  console.log("\n=== APPLIED TO THE AUG 18-24 RAMP ===");
  const dSpend = 1285; // measured: ramp daily spend minus baseline daily spend
  const dWeb = 4.26;   // measured website lift/day
  const predAmz = best.b * dSpend / 1000;
  console.log(`  incremental spend            +$${dSpend}/day`);
  console.log(`  website lift (already seen)  +${dWeb.toFixed(1)}/day`);
  console.log(`  Amazon lift PREDICTED        +${predAmz.toFixed(1)}/day  (95% CI ${(lo * dSpend / 1000).toFixed(1)} … ${(hi * dSpend / 1000).toFixed(1)}), arriving ~day ${best.k}`);
  console.log(`  Amazon lift OBSERVED so far  -1.4/day  ← measured only ${7} days in, before the response window opens`);
  const totalIfLands = dWeb + predAmz;
  console.log(`\n  marginal CAC measured at day 7 (website only + Amazon dip): $452`);
  console.log(`  marginal CAC IF the historical Amazon response lands:      $${(dSpend / totalIfLands).toFixed(0)}  (${totalIfLands.toFixed(1)} customers/day)`);
  console.log(`  break-even ceiling: $${(LTV * CONTRIB).toFixed(0)}`);
  console.log(`\n  ► the Amazon response window for this ramp opens ~Aug 27 and peaks ~Aug 30 - Sep 5.`);
  console.log(`  ► re-measure then. Judging this ramp on day 7 reads the website response only.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
