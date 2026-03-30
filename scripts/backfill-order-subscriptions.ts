#!/usr/bin/env npx tsx
/**
 * Backfill subscription_id on orders that have source_name = 'subscription_contract_checkout_one'
 * but are missing the subscription_id link.
 *
 * Strategy: match by shopify_customer_id → subscriptions table.
 * - If customer has 1 active/paused sub → direct link
 * - If multiple subs → match by SKU overlap between order line_items and sub items
 * - No Appstle API calls — purely DB-based
 *
 * Run: npx tsx scripts/backfill-order-subscriptions.ts
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = resolve(__dirname, "../.env.local");
const lines = readFileSync(envPath, "utf8").split("\n");
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq);
  const val = trimmed.slice(eq + 1);
  if (!process.env[key]) process.env[key] = val;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BATCH_SIZE = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log("Loading subscriptions...");
  // Load all subscriptions for this workspace (should be manageable — hundreds to low thousands)
  const allSubs: { id: string; shopify_customer_id: string; items: unknown[]; status: string }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("id, shopify_customer_id, items, status")
      .eq("workspace_id", WORKSPACE_ID)
      .range(offset, offset + 999);
    if (error) { console.error("Sub load error:", error.message); break; }
    if (!data?.length) break;
    allSubs.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`Loaded ${allSubs.length} subscriptions`);

  // Index subs by shopify_customer_id
  const subsByCustomer = new Map<string, typeof allSubs>();
  for (const s of allSubs) {
    if (!s.shopify_customer_id) continue;
    const existing = subsByCustomer.get(s.shopify_customer_id) || [];
    existing.push(s);
    subsByCustomer.set(s.shopify_customer_id, existing);
  }

  // Process unlinked subscription orders in batches
  let totalLinked = 0;
  let totalSkipped = 0;
  let totalNoMatch = 0;
  let hasMore = true;
  let batchNum = 0;

  while (hasMore) {
    batchNum++;
    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, shopify_customer_id, line_items, source_name")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("source_name", "subscription_contract_checkout_one")
      .is("subscription_id", null)
      .limit(BATCH_SIZE);

    if (error) { console.error("Order fetch error:", error.message); break; }
    if (!orders?.length) { hasMore = false; break; }

    console.log(`Batch ${batchNum}: ${orders.length} orders to process...`);

    for (const order of orders) {
      if (!order.shopify_customer_id) {
        totalSkipped++;
        continue;
      }

      const customerSubs = subsByCustomer.get(order.shopify_customer_id);
      if (!customerSubs?.length) {
        totalNoMatch++;
        continue;
      }

      let matchedSubId: string | null = null;

      if (customerSubs.length === 1) {
        // Single sub for this customer — direct link
        matchedSubId = customerSubs[0].id;
      } else {
        // Multiple subs — match by SKU overlap
        const orderSkus = new Set(
          (Array.isArray(order.line_items) ? order.line_items : [])
            .map((li: { sku?: string }) => li.sku)
            .filter(Boolean)
        );

        if (orderSkus.size > 0) {
          // Prefer active subs over cancelled
          const activeSubs = customerSubs.filter(s => s.status === "active" || s.status === "paused");
          const candidates = activeSubs.length > 0 ? activeSubs : customerSubs;

          for (const sub of candidates) {
            const subSkus = (Array.isArray(sub.items) ? sub.items : [])
              .map((i: { sku?: string }) => i.sku)
              .filter(Boolean);
            if (subSkus.some((sk: string) => orderSkus.has(sk))) {
              matchedSubId = sub.id;
              break;
            }
          }
        }

        // If no SKU match but only one active sub, use that
        if (!matchedSubId) {
          const activeSubs = customerSubs.filter(s => s.status === "active" || s.status === "paused");
          if (activeSubs.length === 1) {
            matchedSubId = activeSubs[0].id;
          }
        }
      }

      if (matchedSubId) {
        const { error: updateErr } = await supabase
          .from("orders")
          .update({ subscription_id: matchedSubId })
          .eq("id", order.id);
        if (updateErr) {
          console.error(`  Update error for order ${order.id}:`, updateErr.message);
        } else {
          totalLinked++;
        }
      } else {
        totalNoMatch++;
      }
    }

    console.log(`  Batch done — linked: ${totalLinked}, no match: ${totalNoMatch}, skipped: ${totalSkipped}`);

    // If we got fewer than BATCH_SIZE, we're done
    if (orders.length < BATCH_SIZE) hasMore = false;
  }

  console.log("\n=== Backfill Summary ===");
  console.log(`Linked: ${totalLinked}`);
  console.log(`No match: ${totalNoMatch}`);
  console.log(`Skipped (no customer): ${totalSkipped}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
