/**
 * Per-engagement-signal lift analysis on the case-control CSV.
 *
 * For each engagement signal (clicked_sms, opened_email, etc.):
 *   - Bucket recipients by signal value
 *   - Compute conversion rate per bucket
 *   - Conditioned globally + on pre_send_orders presence
 *
 * Answers "which engagement signal most predicts purchase?"
 *
 * Usage: npx tsx scripts/engagement-lift-analysis.ts
 */

import { readFileSync, writeFileSync } from "fs";

interface Row {
  converted: number;
  pre_send_orders: number;
  active_sub_at_send: number;
  clicked_sms_60d: number;
  opened_email_60d: number;
  clicked_email_60d: number;
  viewed_product_30d: number;
  added_to_cart_30d: number;
  checkout_started_30d: number;
  active_on_site_90d: number;
  campaign_type: string;
}

const SIGNALS: Array<keyof Row> = [
  "clicked_sms_60d",
  "opened_email_60d",
  "clicked_email_60d",
  "viewed_product_30d",
  "added_to_cart_30d",
  "checkout_started_30d",
  "active_on_site_90d",
];

function parseCsv(path: string): Row[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const header = lines[0].split(",");
  const idx: Record<string, number> = {};
  header.forEach((h, i) => (idx[h] = i));
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.split(",");
    rows.push({
      converted: +c[idx.converted],
      pre_send_orders: +c[idx.pre_send_orders],
      active_sub_at_send: +c[idx.active_sub_at_send],
      clicked_sms_60d: +c[idx.clicked_sms_60d],
      opened_email_60d: +c[idx.opened_email_60d],
      clicked_email_60d: +c[idx.clicked_email_60d],
      viewed_product_30d: +c[idx.viewed_product_30d],
      added_to_cart_30d: +c[idx.added_to_cart_30d],
      checkout_started_30d: +c[idx.checkout_started_30d],
      active_on_site_90d: +c[idx.active_on_site_90d],
      campaign_type: c[idx.campaign_type],
    });
  }
  return rows;
}

function bucket(v: number): string {
  if (v === 0) return "0";
  if (v === 1) return "1";
  if (v <= 3) return "2-3";
  if (v <= 5) return "4-5";
  if (v <= 10) return "6-10";
  return "11+";
}

function aggregate(rows: Row[], signal: keyof Row, filter?: (r: Row) => boolean): Map<string, { n: number; conv: number }> {
  const m = new Map<string, { n: number; conv: number }>();
  for (const r of rows) {
    if (filter && !filter(r)) continue;
    const b = bucket(r[signal] as number);
    const cur = m.get(b) || { n: 0, conv: 0 };
    cur.n++;
    cur.conv += r.converted;
    m.set(b, cur);
  }
  return m;
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return (n / d * 100).toFixed(3) + "%";
}

function lift(rate: number, baseline: number): string {
  if (baseline === 0) return "∞";
  const x = rate / baseline;
  return x.toFixed(1) + "×";
}

function printSignal(rows: Row[], signal: keyof Row, label: string, baseline: number) {
  const agg = aggregate(rows, signal);
  const order = ["0", "1", "2-3", "4-5", "6-10", "11+"];
  console.log(`\n── ${label} ──`);
  console.log("Bucket  | Recipients | Converted |  Conv %   |  Lift vs overall");
  console.log("--------|------------|-----------|-----------|------------------");
  for (const b of order) {
    const v = agg.get(b);
    if (!v || v.n === 0) continue;
    const rate = v.conv / v.n;
    console.log(`${b.padEnd(7)} | ${String(v.n).padStart(10)} | ${String(v.conv).padStart(9)} | ${pct(v.conv, v.n).padStart(9)} | ${lift(rate, baseline).padStart(8)}`);
  }
}

function main() {
  console.log("Loading /tmp/casecontrol-recipients.csv...");
  const rows = parseCsv("/tmp/casecontrol-recipients.csv");
  console.log(`Loaded ${rows.length} recipient rows\n`);

  const totalConv = rows.reduce((s, r) => s + r.converted, 0);
  const totalRec = rows.length;
  const baseline = totalConv / totalRec;
  console.log(`Total: ${totalRec} recipients, ${totalConv} converters, ${pct(totalConv, totalRec)} baseline conversion\n`);

  console.log("══════════════════════════════════════════════════════");
  console.log("ALL RECIPIENTS — single-signal lift");
  console.log("══════════════════════════════════════════════════════");
  for (const s of SIGNALS) printSignal(rows, s, s as string, baseline);

  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("ZERO-ORDER PROFILES ONLY (pre_send_orders === 0)");
  console.log("══════════════════════════════════════════════════════");
  const zeroOrder = rows.filter(r => r.pre_send_orders === 0);
  const zoConv = zeroOrder.reduce((s, r) => s + r.converted, 0);
  const zoBaseline = zoConv / zeroOrder.length;
  console.log(`${zeroOrder.length} zero-order recipients, ${zoConv} converters, ${pct(zoConv, zeroOrder.length)} baseline\n`);
  for (const s of SIGNALS) {
    const agg = aggregate(zeroOrder, s);
    const order = ["0", "1", "2-3", "4-5", "6-10", "11+"];
    console.log(`\n── ${s} (zero-order) ──`);
    console.log("Bucket  | Recipients | Converted |  Conv %   |  Lift vs zero-order baseline");
    console.log("--------|------------|-----------|-----------|------------------");
    for (const b of order) {
      const v = agg.get(b);
      if (!v || v.n === 0) continue;
      const rate = v.conv / v.n;
      console.log(`${b.padEnd(7)} | ${String(v.n).padStart(10)} | ${String(v.conv).padStart(9)} | ${pct(v.conv, v.n).padStart(9)} | ${lift(rate, zoBaseline).padStart(8)}`);
    }
  }

  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("REPEAT BUYERS ONLY (pre_send_orders >= 2)");
  console.log("══════════════════════════════════════════════════════");
  const repeat = rows.filter(r => r.pre_send_orders >= 2);
  const rpConv = repeat.reduce((s, r) => s + r.converted, 0);
  const rpBaseline = rpConv / repeat.length;
  console.log(`${repeat.length} repeat-buyer recipients, ${rpConv} converters, ${pct(rpConv, repeat.length)} baseline\n`);
  for (const s of SIGNALS) {
    const agg = aggregate(repeat, s);
    const order = ["0", "1", "2-3", "4-5", "6-10", "11+"];
    console.log(`\n── ${s} (repeat-buyer) ──`);
    console.log("Bucket  | Recipients | Converted |  Conv %   |  Lift vs repeat baseline");
    console.log("--------|------------|-----------|-----------|------------------");
    for (const b of order) {
      const v = agg.get(b);
      if (!v || v.n === 0) continue;
      const rate = v.conv / v.n;
      console.log(`${b.padEnd(7)} | ${String(v.n).padStart(10)} | ${String(v.conv).padStart(9)} | ${pct(v.conv, v.n).padStart(9)} | ${lift(rate, rpBaseline).padStart(8)}`);
    }
  }

  // ── Composite "has any engagement" indicator ──
  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("COMPOSITE: ANY ENGAGEMENT vs NONE (full audience)");
  console.log("══════════════════════════════════════════════════════");
  const cols: Array<{ label: string; predicate: (r: Row) => boolean }> = [
    { label: "Any clicked_sms_60d >= 1", predicate: r => r.clicked_sms_60d >= 1 },
    { label: "Any opened_email_60d >= 1", predicate: r => r.opened_email_60d >= 1 },
    { label: "Any clicked_email_60d >= 1", predicate: r => r.clicked_email_60d >= 1 },
    { label: "Any viewed_product_30d >= 1", predicate: r => r.viewed_product_30d >= 1 },
    { label: "Any added_to_cart_30d >= 1", predicate: r => r.added_to_cart_30d >= 1 },
    { label: "Any checkout_started_30d >= 1", predicate: r => r.checkout_started_30d >= 1 },
    { label: "Any active_on_site_90d >= 1", predicate: r => r.active_on_site_90d >= 1 },
    { label: "Any of the 7 signals", predicate: r => SIGNALS.some(s => (r[s] as number) >= 1) },
    { label: "ATC OR Checkout (intent signals)", predicate: r => r.added_to_cart_30d >= 1 || r.checkout_started_30d >= 1 },
  ];
  console.log("Indicator                              |    has  |  has% |   noth |  no% | lift");
  console.log("---------------------------------------|---------|-------|--------|------|------");
  for (const c of cols) {
    let has = 0, hasConv = 0, no = 0, noConv = 0;
    for (const r of rows) {
      if (c.predicate(r)) { has++; hasConv += r.converted; } else { no++; noConv += r.converted; }
    }
    const hasRate = has > 0 ? hasConv / has : 0;
    const noRate = no > 0 ? noConv / no : 0;
    const liftStr = noRate > 0 ? (hasRate / noRate).toFixed(1) + "×" : "∞";
    console.log(`${c.label.padEnd(38)} | ${String(hasConv + "/" + has).padStart(7)} | ${pct(hasConv, has).padStart(5)} | ${String(noConv + "/" + no).padStart(6)} | ${pct(noConv, no).padStart(4)} | ${liftStr.padStart(5)}`);
  }

  // ── Zero-order intent isolation ──
  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("ZERO-ORDER + INTENT SIGNALS (the 'real lurker' question)");
  console.log("══════════════════════════════════════════════════════");
  const conds: Array<{ label: string; predicate: (r: Row) => boolean }> = [
    { label: "0 orders, any clicked_sms_60d >= 1", predicate: r => r.pre_send_orders === 0 && r.clicked_sms_60d >= 1 },
    { label: "0 orders, any opened_email_60d >= 1", predicate: r => r.pre_send_orders === 0 && r.opened_email_60d >= 1 },
    { label: "0 orders, any clicked_email_60d >= 1", predicate: r => r.pre_send_orders === 0 && r.clicked_email_60d >= 1 },
    { label: "0 orders, any viewed_product_30d >= 1", predicate: r => r.pre_send_orders === 0 && r.viewed_product_30d >= 1 },
    { label: "0 orders, any added_to_cart_30d >= 1", predicate: r => r.pre_send_orders === 0 && r.added_to_cart_30d >= 1 },
    { label: "0 orders, any checkout_started_30d >= 1", predicate: r => r.pre_send_orders === 0 && r.checkout_started_30d >= 1 },
    { label: "0 orders, any active_on_site_90d >= 1", predicate: r => r.pre_send_orders === 0 && r.active_on_site_90d >= 1 },
    { label: "0 orders, no signals at all", predicate: r => r.pre_send_orders === 0 && SIGNALS.every(s => (r[s] as number) === 0) },
  ];
  console.log("Subgroup                                     | n        | conv   | rate    | lift vs all-zero-order");
  console.log("---------------------------------------------|----------|--------|---------|-----------------------");
  const zoTotal = zeroOrder.length;
  const zoTotalConv = zeroOrder.reduce((s, r) => s + r.converted, 0);
  const zoRate = zoTotalConv / zoTotal;
  for (const c of conds) {
    const sub = rows.filter(c.predicate);
    const subConv = sub.reduce((s, r) => s + r.converted, 0);
    const subRate = sub.length > 0 ? subConv / sub.length : 0;
    const liftStr = zoRate > 0 ? (subRate / zoRate).toFixed(1) + "×" : "∞";
    console.log(`${c.label.padEnd(45)} | ${String(sub.length).padStart(8)} | ${String(subConv).padStart(6)} | ${pct(subConv, sub.length).padStart(7)} | ${liftStr.padStart(6)}`);
  }

  console.log("\n✓ done");
}

main();
