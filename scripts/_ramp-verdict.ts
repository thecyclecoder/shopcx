/**
 * Did the Aug-18 spend ramp actually buy customers?
 *
 * Compares the pre-ramp baseline (Jul 25 – Aug 17) against the ramp window (Aug 18 – Aug 24)
 * and reports the MARGINAL CAC on the incremental dollars, with a Welch t-test on the daily
 * acquisition counts so a 12% lift inside day-to-day noise can't be read as a win.
 *
 * Also measures the Phase 1 flat-line condition directly: new subs vs cancels per day.
 *
 * READ-ONLY. DB-only, ZERO external API calls (no Appstle hits).
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const BASE_FROM = "2026-07-25", BASE_TO = "2026-08-17";
const RAMP_FROM = "2026-08-18", RAMP_TO = "2026-08-24"; // 8/25 excluded: today, partial

const BREAKEVEN_CAC = 139;

const $ = (v: number) => "$" + v.toFixed(0);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const vari = (a: number[]) => a.length < 2 ? 0 : a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1);

/** Welch's t, and a normal-approx two-sided p (n≈24/7 — good enough to say "noise or not"). */
function welch(a: number[], b: number[]) {
  const va = vari(a) / a.length, vb = vari(b) / b.length;
  const t = (mean(b) - mean(a)) / Math.sqrt(va + vb);
  const z = Math.abs(t);
  const p = 2 * (1 - (1 - 0.5 * Math.exp(-0.717 * z - 0.416 * z * z))); // Zelen-Severo approx
  return { t, p: Math.min(1, Math.max(0, p)) };
}

async function pageAll(admin: ReturnType<typeof createAdminClient>, table: string, cols: string, dateCol: string, from: string, to: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols)
      .eq("workspace_id", WS).gte(dateCol, from).lte(dateCol, to).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();

  const spendRows = await pageAll(admin, "daily_meta_ad_spend", "snapshot_date,spend_cents", "snapshot_date", BASE_FROM, RAMP_TO);
  const siteRows = await pageAll(admin, "daily_order_snapshots", "snapshot_date,new_subscription_count,one_time_count", "snapshot_date", BASE_FROM, RAMP_TO);
  const amzRows = await pageAll(admin, "daily_amazon_order_snapshots", "snapshot_date,order_bucket,order_count", "snapshot_date", BASE_FROM, RAMP_TO);

  const spend: Record<string, number> = {}, web: Record<string, number> = {}, amz: Record<string, number> = {};
  for (const r of spendRows) { const d = String(r.snapshot_date); spend[d] = (spend[d] ?? 0) + Number(r.spend_cents ?? 0) / 100; }
  for (const r of siteRows) { const d = String(r.snapshot_date); web[d] = (web[d] ?? 0) + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0); }
  for (const r of amzRows) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    const d = String(r.snapshot_date); amz[d] = (amz[d] ?? 0) + Number(r.order_count ?? 0);
  }

  const daysIn = (a: string, b: string) => Object.keys(spend).filter((d) => d >= a && d <= b).sort();
  const base = daysIn(BASE_FROM, BASE_TO), ramp = daysIn(RAMP_FROM, RAMP_TO);

  const series = (ds: string[], m: Record<string, number>) => ds.map((d) => m[d] ?? 0);
  const tot = (ds: string[], m: Record<string, number>) => series(ds, m).reduce((x, y) => x + y, 0);

  const row = (label: string, ds: string[]) => {
    const s = tot(ds, spend), w = tot(ds, web), a = tot(ds, amz), c = w + a;
    console.log(`  ${label.padEnd(28)} ${ds.length}d   ${$(s / ds.length).padStart(6)}/day   web ${(w / ds.length).toFixed(1).padStart(5)}/day   amz ${(a / ds.length).toFixed(1).padStart(5)}/day   TOTAL ${(c / ds.length).toFixed(1).padStart(5)}/day   CAC ${$(s / c)}`);
    return { s: s / ds.length, w: w / ds.length, a: a / ds.length, c: c / ds.length };
  };

  console.log("=== BASELINE vs RAMP ===");
  const B = row(`baseline ${BASE_FROM}→${BASE_TO}`, base);
  const R = row(`ramp     ${RAMP_FROM}→${RAMP_TO}`, ramp);

  const dS = R.s - B.s, dC = R.c - B.c, dW = R.w - B.w, dA = R.a - B.a;
  console.log(`\n=== WHAT THE INCREMENTAL DOLLARS BOUGHT (per day) ===`);
  console.log(`  extra spend        +${$(dS)}/day  (${(100 * dS / B.s).toFixed(0)}% more)`);
  console.log(`  extra website      ${dW >= 0 ? "+" : ""}${dW.toFixed(1)}/day  (${(100 * dW / B.w).toFixed(0)}%)`);
  console.log(`  extra Amazon       ${dA >= 0 ? "+" : ""}${dA.toFixed(1)}/day  (${(100 * dA / B.a).toFixed(0)}%)`);
  console.log(`  extra TOTAL        ${dC >= 0 ? "+" : ""}${dC.toFixed(1)}/day  (${(100 * dC / B.c).toFixed(0)}%)`);
  console.log(`  ► MARGINAL CAC     ${dC > 0 ? $(dS / dC) : "n/a (no lift)"}  vs break-even ${$(BREAKEVEN_CAC)}`);
  console.log(`  ► website-only     ${dW > 0 ? $(dS / dW) : "n/a"}  (if you credit Amazon with none of the ramp)`);

  const wt = welch(series(base, web), series(ramp, web));
  const ct = welch(base.map((d) => (web[d] ?? 0) + (amz[d] ?? 0)), ramp.map((d) => (web[d] ?? 0) + (amz[d] ?? 0)));
  console.log(`\n=== IS THE LIFT REAL, OR DAY-TO-DAY NOISE? (Welch t-test) ===`);
  console.log(`  website daily count   t=${wt.t.toFixed(2)}  p≈${wt.p.toFixed(3)}  ${wt.p < 0.05 ? "► REAL lift" : "► indistinguishable from noise"}`);
  console.log(`  total daily count     t=${ct.t.toFixed(2)}  p≈${ct.p.toFixed(3)}  ${ct.p < 0.05 ? "► REAL lift" : "► indistinguishable from noise"}`);
  console.log(`  baseline total/day range ${Math.min(...base.map(d => (web[d] ?? 0) + (amz[d] ?? 0)))}–${Math.max(...base.map(d => (web[d] ?? 0) + (amz[d] ?? 0)))} · ramp ${Math.min(...ramp.map(d => (web[d] ?? 0) + (amz[d] ?? 0)))}–${Math.max(...ramp.map(d => (web[d] ?? 0) + (amz[d] ?? 0)))}`);

  // ── Phase 1 flat-line: new subs vs cancels ────────────────────────────────
  // Cancels live in customer_events, NOT on the subscription row (see brain: tables/customer_events).
  console.log(`\n=== PHASE 1 FLAT-LINE (new subs vs cancels) ===`);
  for (const [label, from, to] of [["baseline", BASE_FROM, BASE_TO], ["ramp", RAMP_FROM, RAMP_TO]] as const) {
    const lo = `${from}T00:00:00-05:00`, hi = `${to}T23:59:59.999-05:00`;

    const { count: started, error: e1 } = await admin.from("subscriptions").select("id", { count: "exact", head: true })
      .eq("workspace_id", WS).gte("created_at", lo).lte("created_at", hi);
    if (e1) throw new Error(`subscriptions: ${e1.message}`);

    const evts: Array<{ customer_id: string | null; created_at: string }> = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await admin.from("customer_events").select("customer_id,created_at")
        .eq("workspace_id", WS)
        .in("event_type", ["subscription.cancelled", "portal.subscription.cancelled"])
        .gte("created_at", lo).lte("created_at", hi).range(off, off + 999);
      if (error) throw new Error(`customer_events: ${error.message}`);
      evts.push(...((data ?? []) as typeof evts));
      if (!data || data.length < 1000) break;
    }
    // Dedup the known portal+appstle double-fire: collapse to (customer, minute).
    const cancelled = new Set(evts.map((e) => `${e.customer_id}|${e.created_at.slice(0, 16)}`)).size;

    const days = Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000) + 1;
    const net = (started ?? 0) - cancelled;
    console.log(`  ${label.padEnd(9)} ${String(days).padStart(2)}d   new ${String(started).padStart(3)} (${((started ?? 0) / days).toFixed(1)}/day)   cancels ${String(cancelled).padStart(3)} (${(cancelled / days).toFixed(1)}/day)   NET ${net >= 0 ? "+" : ""}${net} (${(net / days).toFixed(1)}/day)  ${net >= 0 ? "\u2705 growing" : "\u274c shrinking"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
