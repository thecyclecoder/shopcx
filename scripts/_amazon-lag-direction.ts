/**
 * DIRECTIONALITY CHECK — the test that separates a real halo from shared seasonality.
 *
 * _amazon-lag-timescale.ts found the spend↔Amazon relationship only appears at 21-28 day
 * smoothing. That is exactly the width at which two series that merely drift together over
 * 19 months will correlate for reasons that have nothing to do with advertising.
 *
 * The discriminator: if spend CAUSES Amazon orders, the correlation must be ASYMMETRIC in
 * time — stronger when spend leads (positive lag) than when Amazon leads (negative lag).
 * Shared trend/seasonality is symmetric. So we scan lags -42..+42 and compare the two halves.
 *
 *   asymmetric, peak at positive lag  → consistent with a real, delayed ad halo
 *   symmetric, or peak at negative lag → shared drift; the halo claim FAILS
 *
 * Website is carried through as the positive control: it must show a sharp positive-lag peak.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const LAGS = 42;
const WIDTHS = [7, 21, 28];

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function smooth(x: number[], w: number): Array<number | null> {
  if (w <= 1) return x.slice();
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

/** r(target_t, driver_{t-k}); k>0 = driver leads, k<0 = target leads. */
function xcorr(target: Array<number | null>, driver: Array<number | null>, k: number) {
  const a: number[] = [], b: number[] = [];
  for (let i = Math.max(0, k); i < target.length + Math.min(0, k); i++) {
    const t = target[i], d = driver[i - k];
    if (t == null || d == null) continue;
    a.push(t); b.push(d);
  }
  return a.length > 30 ? pearson(a, b) : NaN;
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

  for (const w of WIDTHS) {
    const tw = Math.max(29, w * 5) | 1;
    const ss = detrend(smooth(sv, w), tw), ww = detrend(smooth(wv, w), tw), aa = detrend(smooth(av, w), tw);

    console.log(`\n=== SMOOTHING ${w}d ===`);
    console.log("  lag    AMAZON    WEBSITE      (lag>0 = spend LEADS · lag<0 = orders lead)");
    let bestA = { r: -Infinity, k: 0 };
    const posA: number[] = [], negA: number[] = [];
    for (let k = -LAGS; k <= LAGS; k += 3) {
      const ra = xcorr(aa, ss, k), rw = xcorr(ww, ss, k);
      if (!Number.isNaN(ra) && ra > bestA.r) bestA = { r: ra, k };
      const b = (r: number) => (Number.isNaN(r) ? "" : (r >= 0 ? "▇" : "▁").repeat(Math.round(Math.abs(r) * 30)));
      console.log(`  ${String(k).padStart(4)}   ${ra.toFixed(3).padStart(6)}   ${rw.toFixed(3).padStart(6)}   ${b(ra)}`);
    }
    for (let k = 1; k <= LAGS; k++) { const r = xcorr(aa, ss, k); if (!Number.isNaN(r)) posA.push(r); }
    for (let k = -LAGS; k <= -1; k++) { const r = xcorr(aa, ss, k); if (!Number.isNaN(r)) negA.push(r); }
    const mp = mean(posA), mn = mean(negA);
    console.log(`  Amazon peak r=${bestA.r.toFixed(3)} at lag ${bestA.k}`);
    console.log(`  mean r, spend LEADS (+1..+42): ${mp.toFixed(3)}   |   orders lead (-42..-1): ${mn.toFixed(3)}   asymmetry ${(mp - mn >= 0 ? "+" : "") + (mp - mn).toFixed(3)}`);
    console.log(`  ► ${mp - mn > 0.05 ? "ASYMMETRIC toward spend-leads — consistent with a real halo" : Math.abs(mp - mn) <= 0.05 ? "SYMMETRIC — looks like shared drift, NOT a causal halo" : "peaks when ORDERS lead — cannot be an ad halo"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
