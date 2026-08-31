/**
 * Coffee is out on stock (CEO 2026-08-24). Advertisable: Superfood Tabs,
 * Amazing Creamer, Ashwavana Guru Focus, Ashwavana Zen Relax, Creatine Prime+.
 *
 * The ramp plan was sized on TOTAL acquisition across all products. If Coffee is
 * a meaningful share of it, the same spend cannot buy the same customers and the
 * Phase 1 / Phase 2 numbers need restating.
 *
 * Note the wrinkle inside the wrinkle: the "Amazing Coffee & Creamer" ad account
 * serves BOTH — Creamer stays advertisable, so the account is constrained, not
 * closed.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FROM = "2026-05-01";
const TO = "2026-07-31";

/** null = advertisable, string = why it's blocked. */
const BLOCKED: Record<string, string> = {
  "Amazing Coffee": "stock",
  "Amazing Coffee K-Cups": "stock",
};
const KNOWN = [
  "Superfood Tabs", "Amazing Creamer", "Ashwavana Guru Focus", "Ashwavana Zen Relax",
  "Creatine Prime+", "Amazing Coffee", "Amazing Coffee K-Cups",
];

async function main() {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("order_source_mapping").eq("id", WS).single();
  const sm = (ws?.order_source_mapping ?? {}) as Record<string, string>;

  // ── website: acquisition orders, by product on the line items ──
  const orders: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("orders")
      .select("id,created_at,total_cents,source_name,tags,subscription_id,line_items")
      .eq("workspace_id", WS)
      .gte("created_at", `${FROM}T05:00:00Z`).lt("created_at", "2026-08-01T05:00:00Z")
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    orders.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const site: Record<string, { orders: Set<string>; rev: number }> = {};
  let siteAcqOrders = 0;
  for (const o of orders) {
    const b = bucketOrder(o as never, sm);
    if (b !== "new_sub" && b !== "one_time") continue;
    siteAcqOrders++;
    for (const li of (Array.isArray(o.line_items) ? o.line_items : []) as Array<Record<string, unknown>>) {
      const t = String(li.title ?? li.name ?? "");
      if (!KNOWN.includes(t)) continue;
      site[t] ??= { orders: new Set(), rev: 0 };
      site[t].orders.add(String(o.id));
      site[t].rev += Number(li.price_cents ?? 0) * Number(li.quantity ?? 1);
    }
  }

  // ── amazon: acquisition orders, by product ──
  const amz: Record<string, { orders: number; rev: number }> = {};
  let amzAcqOrders = 0;
  const { data: amzRows } = await admin.from("daily_amazon_product_snapshots")
    .select("product_id,order_bucket,order_count,gross_revenue_cents")
    .eq("workspace_id", WS).gte("snapshot_date", FROM).lte("snapshot_date", TO);
  const pids = [...new Set((amzRows ?? []).map((r) => r.product_id).filter(Boolean))] as string[];
  const { data: prods } = await admin.from("products").select("id,title")
    .in("id", pids.length ? pids : ["00000000-0000-0000-0000-000000000000"]);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));
  for (const r of amzRows ?? []) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    const t = r.product_id ? (title.get(String(r.product_id)) ?? "(unmapped)") : "(unmapped)";
    amz[t] ??= { orders: 0, rev: 0 };
    amz[t].orders += Number(r.order_count ?? 0);
    amz[t].rev += Number(r.gross_revenue_cents ?? 0);
    amzAcqOrders += Number(r.order_count ?? 0);
  }

  const $ = (c: number) => "$" + (c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
  console.log(`=== ACQUISITION BY PRODUCT (${FROM} .. ${TO}) ===\n`);
  console.log("product                      website(ord/$)        amazon(ord/$)      status");
  const all = [...new Set([...Object.keys(site), ...Object.keys(amz)])].sort();
  let blockedSiteOrders = 0, blockedAmzOrders = 0, okSiteOrders = 0, okAmzOrders = 0;
  for (const p of all) {
    const s = site[p] ?? { orders: new Set<string>(), rev: 0 };
    const a = amz[p] ?? { orders: 0, rev: 0 };
    const blocked = BLOCKED[p];
    if (blocked) { blockedSiteOrders += s.orders.size; blockedAmzOrders += a.orders; }
    else { okSiteOrders += s.orders.size; okAmzOrders += a.orders; }
    console.log(
      `${p.slice(0, 26).padEnd(28)} ${String(s.orders.size).padStart(4)} / ${$(s.rev).padStart(8)}   ${String(a.orders).padStart(4)} / ${$(a.rev).padStart(8)}   ${blocked ? "❌ BLOCKED (" + blocked + ")" : "✅ advertisable"}`
    );
  }

  const totalOrders = siteAcqOrders + amzAcqOrders;
  const blockedTotal = blockedSiteOrders + blockedAmzOrders;
  console.log(`\n=== WHAT COFFEE REMOVES ===`);
  console.log(`  total acquisition orders in window : ${totalOrders}  (website ${siteAcqOrders} + amazon ${amzAcqOrders})`);
  console.log(`  attached to a BLOCKED product      : ${blockedTotal}  (website ${blockedSiteOrders} + amazon ${blockedAmzOrders})`);
  console.log(`  → ${((blockedTotal / totalOrders) * 100).toFixed(0)}% of acquisition touches a product we cannot advertise`);
  console.log(`\n  (an order can contain both a blocked and an advertisable product — this counts`);
  console.log(`   any order TOUCHING coffee, so it is an upper bound on what is lost.)`);

  // ── spend by account, to see how much sits behind coffee ──
  const { data: accts } = await admin.from("meta_ad_accounts").select("id,meta_account_name").eq("workspace_id", WS);
  const name = new Map((accts ?? []).map((a) => [String(a.id), String(a.meta_account_name)]));
  const { data: spendRows } = await admin.from("daily_meta_ad_spend")
    .select("meta_ad_account_id,spend_cents").eq("workspace_id", WS)
    .gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const byAcct: Record<string, number> = {};
  for (const r of spendRows ?? []) {
    const n = name.get(String(r.meta_ad_account_id)) ?? "?";
    byAcct[n] = (byAcct[n] ?? 0) + Number(r.spend_cents ?? 0) / 100;
  }
  console.log("\n=== JULY SPEND BY AD ACCOUNT ===");
  for (const [n, v] of Object.entries(byAcct).sort((a, b) => b[1] - a[1])) {
    const note = /coffee/i.test(n) ? "  ← serves Coffee (blocked) AND Creamer (ok)" : "";
    console.log(`  ${n.padEnd(26)} $${v.toFixed(0).padStart(6)}${note}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
