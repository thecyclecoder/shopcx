// Quick analytics: among customers who have at least one order, what's
// the average # of orders and average realized LTV (sum of order totals)?
//
// Why not customer.ltv_cents / total_orders? Those denormalized columns
// drift — Shopify webhooks zero them out occasionally. Compute live
// from the orders table.

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Aggregate orders per customer. Stream paginated so we don't blow up
// on 125k+ orders.
const PAGE = 1000;
let from = 0;
const stats = new Map(); // customer_id -> { orders, total_cents }

console.log("Streaming orders...");
while (true) {
  const { data, error } = await admin
    .from("orders")
    .select("customer_id, total_cents")
    .eq("workspace_id", WORKSPACE_ID)
    .not("customer_id", "is", null)
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) throw error;
  if (!data || data.length === 0) break;

  for (const o of data) {
    const cur = stats.get(o.customer_id) || { orders: 0, total_cents: 0 };
    cur.orders += 1;
    cur.total_cents += o.total_cents || 0;
    stats.set(o.customer_id, cur);
  }

  process.stdout.write(`\r  ${from + data.length} orders processed...`);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log("");

const customersWithOrders = stats.size;
let totalOrders = 0;
let totalLtvCents = 0;
const ordersDist = new Map();

for (const s of stats.values()) {
  totalOrders += s.orders;
  totalLtvCents += s.total_cents;
  ordersDist.set(s.orders, (ordersDist.get(s.orders) || 0) + 1);
}

const avgOrders = totalOrders / customersWithOrders;
const avgLtvCents = totalLtvCents / customersWithOrders;

console.log("");
console.log("=== Customers with at least 1 order ===");
console.log(`Customers:        ${customersWithOrders.toLocaleString()}`);
console.log(`Total orders:     ${totalOrders.toLocaleString()}`);
console.log(`Total revenue:    $${(totalLtvCents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
console.log("");
console.log(`Avg orders/cust:  ${avgOrders.toFixed(2)}`);
console.log(`Avg LTV/cust:     $${(avgLtvCents / 100).toFixed(2)}`);
console.log("");

// Order count distribution (top of the histogram)
console.log("Order-count distribution (top 10):");
const sorted = [...ordersDist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 10);
for (const [n, count] of sorted) {
  const pct = ((count / customersWithOrders) * 100).toFixed(1);
  console.log(`  ${String(n).padStart(3)} order${n === 1 ? " " : "s"}: ${String(count).padStart(7)}  (${pct}%)`);
}

// Repeat-customer rate (2+ orders)
const repeat = [...stats.values()].filter((s) => s.orders >= 2).length;
console.log("");
console.log(`Repeat customers (2+):  ${repeat.toLocaleString()}  (${((repeat / customersWithOrders) * 100).toFixed(1)}%)`);
