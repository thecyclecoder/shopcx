/**
 * Does Amazon acquisition TRAIL a Meta spend ramp by a few days?
 *
 * Dylan's long-standing observation. Tested three ways, on ~600 days of daily history:
 *
 *   1. Cross-correlation of DESEASONALIZED, DETRENDED residuals at lags 0..14.
 *      Raw correlation is worthless here: both series share day-of-week shape and a slow
 *      trend, so they'd correlate at every lag for reasons that have nothing to do with a
 *      causal ad response. We strip a centred 29-day moving average (trend) and a
 *      day-of-week effect from EACH series first, then correlate what's left.
 *
 *   2. WEBSITE AS A CONTROL — this is what makes the hypothesis falsifiable.
 *      A website purchase is a click away, so its response to spend must peak at lag 0-1.
 *      If Amazon's peak lands materially later, the trailing effect is real. If both peak
 *      at the same lag, we're just seeing shared seasonality and the assumption FAILS.
 *
 *   3. Null via CIRCULAR BLOCK SHIFT of the spend residual (2000 draws), recording the max
 *      |r| across the whole lag window. A naive t-test on autocorrelated series wildly
 *      overstates significance; this null preserves each series' own autocorrelation and
 *      gives a family-wise threshold across the 15 lags we look at.
 *
 * Plus an EVENT STUDY over every historical spend ramp, which tests Dylan's phrasing directly.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MAX_LAG = 14;
const TREND_WINDOW = 29; // odd, centred; ~4 weeks so it absorbs level shifts but not the wiggle
const BOOTSTRAP_DRAWS = 2000;
const MIN_SHIFT = 30; // never shift by less than a month, or the null inherits the real alignment

// ── tiny stats helpers ────────────────────────────────────────────────────────
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Centred moving average; endpoints (where the window doesn't fit) come back as null. */
function centredMA(x: Array<number | null>, w: number): Array<number | null> {
  const h = (w - 1) / 2;
  return x.map((_, i) => {
    if (i < h || i >= x.length - h) return null;
    let s = 0;
    for (let j = i - h; j <= i + h; j++) {
      const v = x[j];
      if (v === null) return null;
      s += v;
    }
    return s / w;
  });
}

/**
 * Additive decomposition: value = trend + day-of-week effect + residual.
 * Returns the residual (null wherever it can't be computed).
 */
function deseasonalize(x: Array<number | null>, dow: number[]): Array<number | null> {
  const trend = centredMA(x, TREND_WINDOW);
  const detrended = x.map((v, i) => (v === null || trend[i] === null ? null : v - (trend[i] as number)));

  const byDow: number[][] = Array.from({ length: 7 }, () => []);
  detrended.forEach((v, i) => { if (v !== null) byDow[dow[i]].push(v); });
  const dowEffect = byDow.map((a) => (a.length ? mean(a) : 0));
  // Centre the DOW effects so they don't absorb level.
  const gm = mean(dowEffect);
  const centred = dowEffect.map((v) => v - gm);

  return detrended.map((v, i) => (v === null ? null : v - centred[dow[i]]));
}

/** Cross-correlation r(target_t, driver_{t-k}) over rows where both are present. */
function xcorrAtLag(target: Array<number | null>, driver: Array<number | null>, k: number): { r: number; n: number } {
  const a: number[] = [], b: number[] = [];
  for (let i = k; i < target.length; i++) {
    const t = target[i], d = driver[i - k];
    if (t === null || d === null) continue;
    a.push(t); b.push(d);
  }
  return { r: a.length > 20 ? pearson(a, b) : NaN, n: a.length };
}

function bar(r: number): string {
  const n = Math.round(Math.abs(r) * 60);
  return (r >= 0 ? "▇" : "▁").repeat(Math.max(0, n));
}

// ── load ──────────────────────────────────────────────────────────────────────
async function pageAll(admin: ReturnType<typeof createAdminClient>, table: string, cols: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols)
      .eq("workspace_id", WS).order("snapshot_date").range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();
  const [spendRows, siteRows, amzRows] = await Promise.all([
    pageAll(admin, "daily_meta_ad_spend", "snapshot_date,spend_cents"),
    pageAll(admin, "daily_order_snapshots", "snapshot_date,new_subscription_count,one_time_count"),
    pageAll(admin, "daily_amazon_order_snapshots", "snapshot_date,order_bucket,order_count"),
  ]);

  const S: Record<string, number> = {}, W: Record<string, number> = {}, A: Record<string, number> = {};
  for (const r of spendRows) { const d = String(r.snapshot_date); S[d] = (S[d] ?? 0) + Number(r.spend_cents ?? 0) / 100; }
  for (const r of siteRows) { const d = String(r.snapshot_date); W[d] = (W[d] ?? 0) + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0); }
  for (const r of amzRows) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    const d = String(r.snapshot_date); A[d] = (A[d] ?? 0) + Number(r.order_count ?? 0);
  }

  // Contiguous date index. The newest day is dropped: it is partial and would drag the tail.
  const allDates = [...new Set([...Object.keys(S), ...Object.keys(W), ...Object.keys(A)])].sort();
  const first = allDates[0], last = allDates[allDates.length - 2];
  const dates: string[] = [];
  for (let t = Date.parse(`${first}T12:00:00Z`); t <= Date.parse(`${last}T12:00:00Z`); t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const dow = dates.map((d) => new Date(`${d}T12:00:00Z`).getUTCDay());

  const sv = dates.map((d) => (d in S ? S[d] : null));
  const wv = dates.map((d) => (d in W ? W[d] : null));
  const av = dates.map((d) => (d in A ? A[d] : null));

  const gaps = (x: Array<number | null>) => x.filter((v) => v === null).length;
  console.log(`window ${first} → ${last}  (${dates.length} days)`);
  console.log(`missing days — spend ${gaps(sv)} · website ${gaps(wv)} · amazon ${gaps(av)}\n`);

  const rs = deseasonalize(sv, dow), rw = deseasonalize(wv, dow), ra = deseasonalize(av, dow);

  // ── 1 + 2: cross-correlation, Amazon vs the website control ────────────────
  console.log("=== CROSS-CORRELATION OF DESEASONALIZED RESIDUALS ===");
  console.log("(how strongly does acquisition on day t track spend on day t−k?)\n");
  console.log("lag   WEBSITE (control)              AMAZON (hypothesis)");
  const webR: number[] = [], amzR: number[] = [];
  for (let k = 0; k <= MAX_LAG; k++) {
    const w = xcorrAtLag(rw, rs, k), a = xcorrAtLag(ra, rs, k);
    webR.push(w.r); amzR.push(a.r);
    console.log(
      `${String(k).padStart(3)}   ${w.r.toFixed(3).padStart(6)} ${bar(w.r).padEnd(22).slice(0, 22)}  ${a.r.toFixed(3).padStart(6)} ${bar(a.r)}`,
    );
  }
  const peak = (arr: number[]) => arr.indexOf(Math.max(...arr.map((v) => (Number.isNaN(v) ? -Infinity : v))));
  const wPeak = peak(webR), aPeak = peak(amzR);
  console.log(`\n  website peaks at lag ${wPeak} (r=${webR[wPeak].toFixed(3)})`);
  console.log(`  Amazon  peaks at lag ${aPeak} (r=${amzR[aPeak].toFixed(3)})`);
  console.log(`  ► separation: ${aPeak - wPeak} day(s)`);

  // ── 3: circular-shift null ─────────────────────────────────────────────────
  const rsClean: Array<number | null> = rs.slice();
  const maxNull: number[] = [];
  for (let b = 0; b < BOOTSTRAP_DRAWS; b++) {
    const shift = MIN_SHIFT + Math.floor(Math.random() * (dates.length - 2 * MIN_SHIFT));
    const shifted = rsClean.map((_, i) => rsClean[(i + shift) % rsClean.length]);
    let m = 0;
    for (let k = 0; k <= MAX_LAG; k++) {
      const r = xcorrAtLag(ra, shifted, k).r;
      if (!Number.isNaN(r)) m = Math.max(m, Math.abs(r));
    }
    maxNull.push(m);
  }
  maxNull.sort((x, y) => x - y);
  const q95 = maxNull[Math.floor(0.95 * maxNull.length)];
  const q99 = maxNull[Math.floor(0.99 * maxNull.length)];
  console.log(`\n=== NULL (${BOOTSTRAP_DRAWS} circular shifts of the spend residual) ===`);
  console.log(`  a correlation this far from zero happens by chance up to |r|=${q95.toFixed(3)} (95%) / ${q99.toFixed(3)} (99%)`);
  console.log(`  Amazon peak |r|=${Math.abs(amzR[aPeak]).toFixed(3)} → ${Math.abs(amzR[aPeak]) > q99 ? "SIGNIFICANT at 99%" : Math.abs(amzR[aPeak]) > q95 ? "significant at 95%" : "NOT distinguishable from chance"}`);
  const wq = Math.abs(webR[wPeak]);
  console.log(`  website peak |r|=${wq.toFixed(3)} → ${wq > q99 ? "SIGNIFICANT at 99%" : wq > q95 ? "significant at 95%" : "NOT distinguishable from chance"}`);

  // ── event study over every historical spend ramp ───────────────────────────
  console.log(`\n=== EVENT STUDY: every historical spend ramp ===`);
  const trail = (x: Array<number | null>, i: number, n: number) => {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) { const v = x[j]; if (v == null) return null; s += v; }
    return s / n;
  };
  const events: number[] = [];
  for (let i = 14; i < dates.length - MAX_LAG; i++) {
    const cur = trail(sv, i, 7), prev = trail(sv, i - 7, 7);
    if (cur == null || prev == null || prev < 100) continue;
    if (cur / prev >= 1.5 && (events.length === 0 || i - events[events.length - 1] >= 14)) events.push(i);
  }
  console.log(`  ${events.length} ramp events (7-day spend up ≥50% vs the prior 7 days, ≥14d apart)`);
  console.log(`  event dates: ${events.map((i) => dates[i]).join(", ")}\n`);

  if (events.length >= 3) {
    console.log("  day rel.   spend vs pre    website vs pre    amazon vs pre");
    for (let k = -3; k <= MAX_LAG; k++) {
      const rel = (x: Array<number | null>) => {
        const vals: number[] = [];
        for (const e of events) {
          const base = trail(x, e - 8, 7); // the 7 days BEFORE the ramp began
          const v = x[e + k];
          if (base == null || v == null || base <= 0) continue;
          vals.push(v / base);
        }
        return vals.length ? mean(vals) : NaN;
      };
      const s = rel(sv), w = rel(wv), a = rel(av);
      const pct = (v: number) => (Number.isNaN(v) ? "  —  " : ((v - 1) * 100 >= 0 ? "+" : "") + ((v - 1) * 100).toFixed(0) + "%");
      console.log(`  ${String(k).padStart(6)}     ${pct(s).padStart(8)}        ${pct(w).padStart(8)}          ${pct(a).padStart(8)}  ${bar(Math.max(0, (a - 1)) * 2)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
