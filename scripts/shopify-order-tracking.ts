/**
 * Pull live fulfillment data straight from Shopify for an order — used
 * to confirm tracking before responding to the customer.
 *
 * Usage:
 *   npx tsx scripts/shopify-order-tracking.ts <SC######>
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const orderNumber = process.argv[2];
if (!orderNumber) { console.error("Usage: npx tsx scripts/shopify-order-tracking.ts <order_number>"); process.exit(1); }

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: order } = await admin
    .from("orders")
    .select("shopify_order_id")
    .eq("workspace_id", W)
    .eq("order_number", orderNumber)
    .single();
  if (!order) { console.log("Order not found in our DB"); process.exit(1); }
  console.log(`Shopify order ID: ${order.shopify_order_id}`);

  const { getShopifyCredentials } = await import("../src/lib/shopify-sync");
  const { SHOPIFY_API_VERSION } = await import("../src/lib/shopify");
  const { shop, accessToken } = await getShopifyCredentials(W);

  const query = `
    query OrderFulfillments($id: ID!) {
      order(id: $id) {
        name
        displayFulfillmentStatus
        fulfillments(first: 10) {
          status
          createdAt
          updatedAt
          trackingInfo(first: 5) { number url company }
          totalQuantity
        }
      }
    }
  `;

  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id: `gid://shopify/Order/${order.shopify_order_id}` } }),
  });
  const json = await res.json();
  if (json.errors) { console.error(JSON.stringify(json.errors, null, 2)); process.exit(1); }

  const o = json.data.order;
  console.log(`\nOrder ${o?.name}  fulfillment=${o?.displayFulfillmentStatus}`);
  console.log(`Fulfillments:`);
  for (const f of o?.fulfillments || []) {
    console.log(`  ${f.status}  qty=${f.totalQuantity}  created=${f.createdAt}`);
    for (const t of f.trackingInfo || []) {
      console.log(`    📦 ${t.company || "?"}  #${t.number}  ${t.url}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
