/**
 * THE decisive question: does Meta spend drive Amazon acquisition?
 *
 * It sets CAC — and therefore whether to scale:
 *   halo real      -> denominator = website + Amazon checkouts -> CAC ~$41, LTV:CAC 5.6x
 *   halo not real  -> denominator = website only               -> CAC ~$230, LTV:CAC ~1.4-2.0
 *
 * Tested three ways over the longest series we have:
 *   1. monthly correlation, Meta spend vs Amazon acquisition orders
 *   2. lagged daily/weekly correlation (a halo should show up at 0-14 days)
 *   3. the natural experiments — periods where spend moved 5x+
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

function corr(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return NaN;
  const a = xs.slice(0, n), b = ys.slice(0, n);
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  const sa = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0));
  const sb = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0));
  return sa && sb ? cov / (sa * sb) : NaN;
}

async function pageAll(admin: ReturnType<typeof createAdminClient>, table: string, cols: string, from: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols)
      .eq("workspace_id", WS).gte("snapshot_date", from).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();
  const FROM = "2025-01-01";

  const spendRows = await pageAll(admin, "daily_meta_ad_spend", "snapshot_date,spend_cents", FROM);
  const amzRows = await pageAll(admin, "daily_amazon_order_snapshots", "snapshot_date,order_bucket,order_count,gross_revenue_cents", FROM);

  const spendByDay: Record<string, number> = {};
  for (const r of spendRows) {
    const d = String(r.snapshot_date);
    spendByDay[d] = (spendByDay[d] ?? 0) + Number(r.spend_cents ?? 0) / 100;
  }
  const amzByDay: Record<string, number> = {};
  const amzRevByDay: Record<string, number> = {};
  for (const r of amzRows) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    const d = String(r.snapshot_date);
    amzByDay[d] = (amzByDay[d] ?? 0) + Number(r.order_count ?? 0);
    amzRevByDay[d] = (amzRevByDay[d] ?? 0) + Number(r.gross_revenue_cents ?? 0) / 100;
  }

  // ── 1. MONTHLY ──
  const mSpend: Record<string, number> = {}, mAmz: Record<string, number> = {};
  for (const [d, v] of Object.entries(spendByDay)) mSpend[d.slice(0, 7)] = (mSpend[d.slice(0, 7)] ?? 0) + v;
  for (const [d, v] of Object.entries(amzByDay)) mAmz[d.slice(0, 7)] = (mAmz[d.slice(0, 7)] ?? 0) + v;
  const months = Object.keys(mSpend).filter((m) => mAmz[m] != null && m < new Date().toISOString().slice(0, 7)).sort();

  console.log("=== 1. MONTHLY — Meta spend vs Amazon acquisition orders ===");
  console.log("month     MetaSpend   AmzAcqOrders   impliedAmzCAC");
  for (const m of months) {
    console.log(`${m}   ${("$" + mSpend[m].toFixed(0)).padStart(9)}   ${String(mAmz[m]).padStart(12)}   ${mAmz[m] ? "$" + (mSpend[m] / mAmz[m]).toFixed(0) : "—"}`);
  }
  const r1 = corr(months.map((m) => mSpend[m]), months.map((m) => mAmz[m]));
  console.log(`\n  corr(Meta spend, Amazon acquisition orders) = ${r1.toFixed(2)}   (n=${months.length} months)`);

  // ── 2. LAGGED WEEKLY ──
  const weekOf = (d: string) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return new Date(t - new Date(t).getUTCDay() * 86400000).toISOString().slice(0, 10);
  };
  const wSpend: Record<string, number> = {}, wAmz: Record<string, number> = {};
  for (const [d, v] of Object.entries(spendByDay)) wSpend[weekOf(d)] = (wSpend[weekOf(d)] ?? 0) + v;
  for (const [d, v] of Object.entries(amzByDay)) wAmz[weekOf(d)] = (wAmz[weekOf(d)] ?? 0) + v;
  const weeks = Object.keys(wSpend).filter((w) => wAmz[w] != null).sort();

  console.log("\n=== 2. LAGGED WEEKLY CORRELATION (a real halo shows up within 0-2 weeks) ===");
  for (const lag of [0, 1, 2, 3, 4]) {
    const xs = weeks.slice(0, weeks.length - lag).map((w) => wSpend[w]);
    const ys = weeks.slice(lag).map((w) => wAmz[w]);
    console.log(`  lag ${lag} week(s):  r = ${corr(xs, ys).toFixed(2)}   (n=${xs.length})`);
  }

  // ── 3. NATURAL EXPERIMENTS ──
  console.log("\n=== 3. NATURAL EXPERIMENTS — periods where spend moved hard ===");
  const windows: Array<[string, string, string]> = [
    ["2025-10-01", "2025-11-30", "peak spend"],
    ["2026-03-01", "2026-04-30", "post-cut"],
    ["2026-07-01", "2026-07-20", "July spike"],
    ["2026-07-27", "2026-08-15", "July/Aug trough"],
  ];
  for (const [a, b, label] of windows) {
    const days = Object.keys(spendByDay).filter((d) => d >= a && d <= b).sort();
    if (!days.length) continue;
    const sp = days.reduce((s, d) => s + (spendByDay[d] ?? 0), 0) / days.length;
    const am = days.reduce((s, d) => s + (amzByDay[d] ?? 0), 0) / days.length;
    const ar = days.reduce((s, d) => s + (amzRevByDay[d] ?? 0), 0) / days.length;
    console.log(`  ${label.padEnd(18)} ${a}..${b}   MetaSpend/day $${sp.toFixed(0).padStart(5)}   AmzAcq/day ${am.toFixed(1).padStart(5)}   AmzRev/day $${ar.toFixed(0)}`);
  }

  // ── verdict ──
  console.log("\n=== WHAT THIS MEANS FOR CAC ===");
  const jul = "2026-07";
  const { data: dos } = await admin.from("daily_order_snapshots")
    .select("new_subscription_count,one_time_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const siteCheckouts = (dos ?? []).reduce((s, r) => s + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0), 0);
  const spend = mSpend[jul] ?? 0;
  const amz = mAmz[jul] ?? 0;
  console.log(`  July: Meta spend $${spend.toFixed(0)}   website checkouts ${siteCheckouts}   Amazon acquisition orders ${amz}`);
  console.log(`    website-only denominator : CAC $${(spend / Math.max(siteCheckouts, 1)).toFixed(0)}`);
  console.log(`    website + Amazon         : CAC $${(spend / Math.max(siteCheckouts + amz, 1)).toFixed(0)}`);
  console.log(`  The gap between those two IS the halo question. If corr above is ~0, the low number is not earned.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
