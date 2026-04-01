/**
 * Refund duplicate orders caused by false dunning triggers on 2026-03-29.
 *
 * Logic: For each recovered dunning cycle, find cases where a paid order
 * existed BEFORE dunning started (within the billing cycle window).
 * The NEWER order (created after dunning recovery) is the duplicate — refund that one.
 *
 * Usage:
 *   npx tsx scripts/refund-dunning-duplicates.ts --dry-run    # Preview only
 *   npx tsx scripts/refund-dunning-duplicates.ts --execute     # Actually refund
 */

import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// --- Args ---
const mode = process.argv.includes("--execute") ? "execute" : "dry-run";

// --- Env ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const encryptionKey = process.env.ENCRYPTION_KEY!;

if (!supabaseUrl || !serviceKey || !encryptionKey) {
  console.error("Missing env vars. Run: set -a && source .env.local && set +a");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

function decrypt(encrypted: string): string {
  const [ivHex, tagHex, cipherHex] = encrypted.split(":");
  const key = Buffer.from(encryptionKey, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const cipher = Buffer.from(cipherHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(cipher, undefined, "utf8") + decipher.final("utf8");
}

interface RefundTarget {
  duplicateOrderNumber: string;
  duplicateShopifyId: string;
  duplicateCreatedAt: string;
  originalOrderNumber: string;
  originalCreatedAt: string;
  amountCents: number;
  customerEmail: string;
  customerName: string;
  subscriptionId: string;
  dunningCycleId: string;
}

async function findDuplicates(): Promise<RefundTarget[]> {
  // Get all recovered dunning cycles
  const { data: cycles } = await supabase
    .from("dunning_cycles")
    .select("id, shopify_contract_id, subscription_id, customer_id, status, created_at, recovered_at")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("status", "recovered")
    .order("created_at", { ascending: true });

  const targets: RefundTarget[] = [];

  for (const cycle of cycles || []) {
    if (!cycle.subscription_id) continue;

    // Get billing interval
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("billing_interval, billing_interval_count")
      .eq("id", cycle.subscription_id)
      .single();

    if (!sub) continue;

    const interval = sub.billing_interval || "month";
    const count = sub.billing_interval_count || 1;
    let cycleDays = 28;
    if (interval === "week") cycleDays = 7 * count;
    else if (interval === "month") cycleDays = 28 * count;
    else if (interval === "year") cycleDays = 365 * count;
    else if (interval === "day") cycleDays = count;

    const cutoff = new Date(new Date(cycle.created_at).getTime() - cycleDays * 24 * 60 * 60 * 1000).toISOString();

    // Find the ORIGINAL paid order (before dunning started)
    const { data: originalOrder } = await supabase
      .from("orders")
      .select("id, order_number, created_at, total_cents")
      .eq("subscription_id", cycle.subscription_id)
      .eq("financial_status", "paid")
      .gte("created_at", cutoff)
      .lt("created_at", cycle.created_at)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!originalOrder) continue; // Not a false trigger

    // Find the DUPLICATE order (created after dunning recovery)
    const { data: duplicateOrder } = await supabase
      .from("orders")
      .select("id, order_number, shopify_order_id, created_at, total_cents, email")
      .eq("subscription_id", cycle.subscription_id)
      .eq("financial_status", "paid")
      .gte("created_at", cycle.created_at)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (!duplicateOrder || !duplicateOrder.shopify_order_id) continue;

    // Verify amounts match (extra safety)
    if (duplicateOrder.total_cents !== originalOrder.total_cents) {
      console.log(`  SKIPPING ${duplicateOrder.order_number}: amount mismatch ($${(duplicateOrder.total_cents / 100).toFixed(2)} vs $${(originalOrder.total_cents / 100).toFixed(2)})`);
      continue;
    }

    // Get customer info
    const { data: customer } = await supabase
      .from("customers")
      .select("email, first_name, last_name")
      .eq("id", cycle.customer_id)
      .single();

    targets.push({
      duplicateOrderNumber: duplicateOrder.order_number,
      duplicateShopifyId: duplicateOrder.shopify_order_id,
      duplicateCreatedAt: duplicateOrder.created_at,
      originalOrderNumber: originalOrder.order_number,
      originalCreatedAt: originalOrder.created_at,
      amountCents: duplicateOrder.total_cents,
      customerEmail: customer?.email || duplicateOrder.email || "",
      customerName: `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim(),
      subscriptionId: cycle.subscription_id,
      dunningCycleId: cycle.id,
    });
  }

  return targets;
}

async function refundOrder(
  shopifyDomain: string,
  accessToken: string,
  shopifyOrderId: string,
  orderNumber: string,
): Promise<{ success: boolean; error?: string }> {
  // Step 1: Get the order to find the transaction to refund
  const orderQuery = `{
    order(id: "gid://shopify/Order/${shopifyOrderId}") {
      id
      name
      totalPriceSet { shopMoney { amount currencyCode } }
      transactions(first: 5) {
        id amount gateway status kind createdAt
      }
    }
  }`;

  const orderRes = await fetch(`https://${shopifyDomain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query: orderQuery }),
  });

  const orderJson = await orderRes.json();
  const order = orderJson.data?.order;

  if (!order) return { success: false, error: "Order not found in Shopify" };

  // Find the successful SALE transaction
  const saleTx = order.transactions?.find(
    (t: { status: string; kind: string }) => t.status === "SUCCESS" && t.kind === "SALE"
  );

  if (!saleTx) return { success: false, error: "No successful SALE transaction found" };

  // Step 2: Create refund via REST API (GraphQL refund mutations are complex)
  // Use the Shopify REST Admin API for refunds
  const refundRes = await fetch(
    `https://${shopifyDomain}/admin/api/2024-10/orders/${shopifyOrderId}/refunds.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refund: {
          note: "Refund for duplicate charge caused by billing system error on 2026-03-29",
          transactions: [
            {
              parent_id: saleTx.id.replace("gid://shopify/OrderTransaction/", ""),
              amount: saleTx.amount,
              kind: "refund",
              gateway: saleTx.gateway,
            },
          ],
        },
      }),
    }
  );

  if (!refundRes.ok) {
    const err = await refundRes.text();
    return { success: false, error: `Shopify refund failed (${refundRes.status}): ${err.substring(0, 200)}` };
  }

  return { success: true };
}

async function main() {
  console.log(`\n=== Dunning Duplicate Refund Script (${mode.toUpperCase()}) ===\n`);

  // Get Shopify credentials
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("shopify_access_token_encrypted, shopify_myshopify_domain")
    .eq("id", WORKSPACE_ID)
    .single();

  if (!workspace?.shopify_access_token_encrypted || !workspace?.shopify_myshopify_domain) {
    console.error("Shopify not connected");
    process.exit(1);
  }

  const accessToken = decrypt(workspace.shopify_access_token_encrypted);
  const shopifyDomain = workspace.shopify_myshopify_domain;

  // Find all duplicates
  console.log("Finding duplicate orders...\n");
  const targets = await findDuplicates();

  if (targets.length === 0) {
    console.log("No duplicate orders found.");
    return;
  }

  // Print summary
  const totalRefund = targets.reduce((sum, t) => sum + t.amountCents, 0);
  console.log(`Found ${targets.length} duplicate orders to refund.`);
  console.log(`Total refund amount: $${(totalRefund / 100).toFixed(2)}\n`);

  console.log("Order            | Original         | Amount    | Customer");
  console.log("-".repeat(80));
  for (const t of targets) {
    console.log(
      `${t.duplicateOrderNumber.padEnd(17)}| ${t.originalOrderNumber.padEnd(17)}| $${(t.amountCents / 100).toFixed(2).padEnd(9)}| ${t.customerName} (${t.customerEmail})`
    );
  }

  if (mode === "dry-run") {
    console.log(`\n--- DRY RUN complete. Run with --execute to process refunds. ---\n`);
    return;
  }

  // Execute refunds
  console.log(`\nProcessing ${targets.length} refunds...\n`);

  let succeeded = 0;
  let failed = 0;

  for (const t of targets) {
    process.stdout.write(`  Refunding ${t.duplicateOrderNumber} ($${(t.amountCents / 100).toFixed(2)})... `);

    const result = await refundOrder(shopifyDomain, accessToken, t.duplicateShopifyId, t.duplicateOrderNumber);

    if (result.success) {
      console.log("OK");
      succeeded++;
    } else {
      console.log(`FAILED: ${result.error}`);
      failed++;
    }

    // Rate limit: 2 requests per second
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. ${succeeded} refunded, ${failed} failed.`);
  console.log(`Total refunded: $${(targets.filter((_, i) => i < succeeded).reduce((s, t) => s + t.amountCents, 0) / 100).toFixed(2)}`);
}

main().catch(console.error);
