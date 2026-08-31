/**
 * At WHAT TIMESCALE does Amazon respond to Meta spend?
 *
 * Companion to _amazon-lag-test.ts, which found no daily-scale response. That test is blind
 * to a slow effect BY CONSTRUCTION: it removes a centred 29-day moving average, so any Amazon
 * response that builds over weeks gets absorbed into the "trend" it subtracts. Since the
 * monthly spend↔Amazon correlation is strong, the honest question is not "is there a lag"
 * but "at what smoothing width does the relationship appear, and how far behind spend is it".
 *
 * So: sweep the smoothing width (1, 3, 7, 14, 21, 28 days), and for each, scan lags 0..42.
 * The detrend window scales with the smoothing width (always ≫ it) so it can never eat the
 * signal it is meant to be a control for.
 *
 * Also reports the MINIMUM DETECTABLE EFFECT — what size of Amazon response we had the power
 * to see. "We found nothing" is only meaningful alongside "we could have found X".
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MAX_LAG = 42;
const WIDTHS = [1, 3, 7, 14, 21, 28];
const DRAWS = 1000;
const MIN_SHIFT = 45;

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1));

function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Trailing mean over `w` days (w=1 is the raw series). */
function smooth(x: number[], w: number): Array<number | null> {
  if (w <= 1) return x.slice();
  return x.map((_, i) => {
    if (i < w - 1) return null;
    let s = 0;
    for (let j = i - w + 1; j <= i; j++) s += x[j];
    return s / w;
  });
}

function centredMA(x: Array<number | null>, w: number): Array<number | null> {
  const h = Math.floor((w - 1) / 2);
  return x.map((_, i) => {
    if (i < h || i >= x.length - h) return null;
    let s = 0, n = 0;
    for (let j = i - h; j <= i + h; j++) { const v = x[j]; if (v === null) return null; s += v; n++; }
    return s / n;
  });
}

/** Remove a centred moving average of width `trendW` (must be ≫ the smoothing width). */
function detrend(x: Array<number | null>, trendW: number): Array<number | null> {
  const t = centredMA(x, trendW);
  return x.map((v, i) => (v === null || t[i] === null ? null : v - (t[i] as number)));
}

function xcorr(target: Array<number | null>, driver: Array<number | null>, k: number) {
  const a: number[] = [], b: number[] = [];
  for (let i = k; i < target.length; i++) {
    const t = target[i], d = driver[i - k];
    if (t === null || d === null) continue;
    a.push(t); b.push(d);
  }
  return a.length > 30 ? pearson(a, b) : NaN;
}

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

  const all = [...new Set([...Object.keys(S), ...Object.keys(W), ...Object.keys(A)])].sort();
  const first = all[0], last = all[all.length - 2]; // drop the partial newest day
  const dates: string[] = [];
  for (let t = Date.parse(`${first}T12:00:00Z`); t <= Date.parse(`${last}T12:00:00Z`); t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const sv = dates.map((d) => S[d] ?? 0), wv = dates.map((d) => W[d] ?? 0), av = dates.map((d) => A[d] ?? 0);
  console.log(`window ${first} → ${last} (${dates.length} days)`);
  console.log(`daily means — spend $${mean(sv).toFixed(0)} · website ${mean(wv).toFixed(1)} · amazon ${mean(av).toFixed(1)}`);
  console.log(`daily sd    — spend $${sd(sv).toFixed(0)} · website ${sd(wv).toFixed(1)} · amazon ${sd(av).toFixed(1)}\n`);

  console.log("=== PEAK CORRELATION BY SMOOTHING WIDTH ===");
  console.log("(trailing mean of `w` days; detrended at 5x that width so the trend can't eat the signal)\n");
  console.log("  smoothing   WEBSITE peak (lag)     AMAZON peak (lag)     95% chance threshold");

  for (const w of WIDTHS) {
    const trendW = Math.max(29, w * 5) | 1; // odd
    const ss = detrend(smooth(sv, w), trendW);
    const ww = detrend(smooth(wv, w), trendW);
    const aa = detrend(smooth(av, w), trendW);

    let bw = { r: -Infinity, k: 0 }, ba = { r: -Infinity, k: 0 };
    for (let k = 0; k <= MAX_LAG; k++) {
      const rw = xcorr(ww, ss, k), ra = xcorr(aa, ss, k);
      if (!Number.isNaN(rw) && rw > bw.r) bw = { r: rw, k };
      if (!Number.isNaN(ra) && ra > ba.r) ba = { r: ra, k };
    }

    // Circular-shift null on the SPEND residual, family-wise across all lags scanned.
    const nulls: number[] = [];
    for (let b = 0; b < DRAWS; b++) {
      const shift = MIN_SHIFT + Math.floor(Math.random() * (dates.length - 2 * MIN_SHIFT));
      const sh = ss.map((_, i) => ss[(i + shift) % ss.length]);
      let m = 0;
      for (let k = 0; k <= MAX_LAG; k++) { const r = xcorr(aa, sh, k); if (!Number.isNaN(r)) m = Math.max(m, Math.abs(r)); }
      nulls.push(m);
    }
    nulls.sort((x, y) => x - y);
    const q95 = nulls[Math.floor(0.95 * nulls.length)];

    const mark = (r: number) => (r > q95 ? "✅" : "  ");
    console.log(
      `  ${String(w + "d").padStart(9)}   ${bw.r.toFixed(3)} (lag ${String(bw.k).padStart(2)}) ${mark(bw.r)}     ${ba.r.toFixed(3)} (lag ${String(ba.k).padStart(2)}) ${mark(ba.r)}          ${q95.toFixed(3)}`,
    );
  }

  // ── Minimum detectable effect at the daily scale ──────────────────────────
  console.log("\n=== POWER: what daily Amazon response COULD we have seen? ===");
  const trendW = 29;
  const ssD = detrend(smooth(sv, 1), trendW);
  const aaD = detrend(smooth(av, 1), trendW);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < dates.length; i++) { const s = ssD[i], a = aaD[i]; if (s !== null && a !== null) pairs.push([s, a]); }
  const sSd = sd(pairs.map((p) => p[0])), aSd = sd(pairs.map((p) => p[1]));
  const q95daily = 0.165; // from _amazon-lag-test.ts null, same construction
  const betaMDE = q95daily * aSd / sSd; // orders per $1 of same-day spend deviation
  console.log(`  residual sd — spend $${sSd.toFixed(0)}/day · amazon ${aSd.toFixed(1)} orders/day`);
  console.log(`  smallest slope we could have detected: ${(betaMDE * 1000).toFixed(2)} Amazon orders per +$1,000/day`);
  console.log(`  → an effect SMALLER than that is invisible to this test. It is NOT ruled out.`);
  console.log(`  for scale: the website slope over the Aug ramp was ~3.3 orders per +$1,000/day.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
