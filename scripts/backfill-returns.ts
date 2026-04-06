#!/usr/bin/env npx tsx
/**
 * Backfill returns from Shopify GraphQL for the last 90 days.
 * Links to existing orders, customers, and subscriptions in our DB.
 *
 * Usage: npx tsx scripts/backfill-returns.ts
 */

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SHOPIFY_API_VERSION = "2025-01";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function getShopifyCreds() {
  const { data } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", WORKSPACE_ID)
    .single();
  if (!data?.shopify_access_token_encrypted) throw new Error("No Shopify credentials");
  return { shop: data.shopify_myshopify_domain, token: decrypt(data.shopify_access_token_encrypted) };
}

async function shopifyGQL(shop: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) console.error("GraphQL errors:", json.errors);
  return json.data;
}

// Map Shopify return status to our status
function mapStatus(shopifyStatus: string): string {
  switch (shopifyStatus) {
    case "OPEN": return "open";
    case "CLOSED": return "closed";
    case "CANCELED": return "cancelled";
    case "REQUESTED": return "pending";
    case "DECLINED": return "cancelled";
    default: return "open";
  }
}

async function main() {
  const { shop, token } = await getShopifyCreds();
  console.log(`Shop: ${shop}`);

  const sinceDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
  console.log(`Fetching returns since ${sinceDate}...`);

  let cursor: string | null = null;
  let totalOrders = 0;
  let totalReturns = 0;
  let inserted = 0;
  let skipped = 0;

  // Paginate through orders with returns
  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const data = await shopifyGQL(shop, token, `
      query {
        orders(first: 50${afterClause}, query: "return_status:returned OR return_status:in_progress OR return_status:return_requested created_at:>${sinceDate}") {
          edges {
            cursor
            node {
              id
              name
              createdAt
              totalPriceSet { shopMoney { amount } }
              returns(first: 20) {
                nodes {
                  id
                  name
                  status
                  returnLineItems(first: 50) {
                    nodes {
                      id
                      quantity
                      returnReason
                      returnReasonNote
                    }
                  }
                  reverseFulfillmentOrders(first: 5) {
                    nodes {
                      id
                      status
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `);

    const edges = data?.orders?.edges || [];
    if (!edges.length) break;

    totalOrders += edges.length;

    for (const edge of edges) {
      cursor = edge.cursor;
      const order = edge.node;
      const shopifyOrderId = order.id.replace("gid://shopify/Order/", "");
      const orderNumber = order.name;
      const orderTotalCents = Math.round(parseFloat(order.totalPriceSet.shopMoney.amount) * 100);

      // Find our internal order
      const { data: dbOrder } = await admin
        .from("orders")
        .select("id, customer_id, order_number")
        .eq("workspace_id", WORKSPACE_ID)
        .eq("shopify_order_id", shopifyOrderId)
        .single();

      for (const ret of order.returns.nodes) {
        totalReturns++;
        const shopifyReturnGid = ret.id;

        // Check if already exists
        const { data: existing } = await admin
          .from("returns")
          .select("id")
          .eq("shopify_return_gid", shopifyReturnGid)
          .single();

        if (existing) {
          skipped++;
          continue;
        }

        // Build return line items
        const returnLineItems = (ret.returnLineItems?.nodes || []).map((rli: {
          id: string;
          quantity: number;
          returnReason: string | null;
          returnReasonNote: string | null;
        }) => ({
          shopify_return_line_item_id: rli.id,
          quantity: rli.quantity,
          title: `Return item (${rli.returnReason || "unknown reason"})`,
          reason: rli.returnReason,
          note: rli.returnReasonNote,
        }));

        // Get reverse fulfillment order info
        const rfo = ret.reverseFulfillmentOrders?.nodes?.[0];
        const rfoGid = rfo?.id || null;

        // Determine status
        let status = mapStatus(ret.status);
        const rfoStatus = rfo?.status;
        if (rfoStatus === "COMPLETED" && status === "open") status = "restocked";
        if (ret.status === "CLOSED") status = "closed";

        // Try to find linked subscription via customer
        let customerId = dbOrder?.customer_id || null;
        if (!customerId && dbOrder) {
          // Try via order's customer
          const { data: cust } = await admin
            .from("customers")
            .select("id")
            .eq("workspace_id", WORKSPACE_ID)
            .eq("shopify_customer_id", shopifyOrderId) // fallback
            .single();
          customerId = cust?.id || null;
        }

        const row = {
          workspace_id: WORKSPACE_ID,
          order_id: dbOrder?.id || null,
          order_number: orderNumber,
          shopify_order_gid: order.id,
          customer_id: customerId,
          shopify_return_gid: shopifyReturnGid,
          shopify_reverse_fulfillment_order_gid: rfoGid,
          status,
          resolution_type: "refund_return" as const, // Default — we can't determine this from Shopify
          source: "shopify" as const,
          order_total_cents: orderTotalCents,
          net_refund_cents: orderTotalCents,
          return_line_items: returnLineItems,
          created_at: order.createdAt, // Use order date since Return doesn't have createdAt
          processed_at: rfoStatus === "COMPLETED" ? new Date().toISOString() : null,
          refunded_at: status === "closed" ? new Date().toISOString() : null,
        };

        const { error } = await admin.from("returns").insert(row);
        if (error) {
          console.error(`  Failed to insert return ${shopifyReturnGid}: ${error.message}`);
        } else {
          inserted++;
          console.log(`  Inserted: ${orderNumber} — ${ret.name} (${status}) — ${returnLineItems.length} items — $${(orderTotalCents / 100).toFixed(2)}`);
        }
      }
    }

    if (!data?.orders?.pageInfo?.hasNextPage) break;
    console.log(`  ...fetched ${totalOrders} orders so far, continuing...`);

    // Rate limit pause
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone.`);
  console.log(`Orders with returns: ${totalOrders}`);
  console.log(`Returns found: ${totalReturns}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped (already exist): ${skipped}`);
}

main().catch(console.error);
