/**
 * One-time backfill: Query Amplifier API for all orders, match by order_number,
 * and update our DB with amplifier_order_id, amplifier_received_at, amplifier_status,
 * and shipping info if available.
 *
 * Usage: npx tsx scripts/backfill-amplifier-uuids.ts
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local manually (no dotenv dependency)
const envPath = resolve(process.cwd(), ".env.local");
try {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error("Supabase env vars required");
if (!encryptionKey || encryptionKey.length !== 64) throw new Error("ENCRYPTION_KEY must be a 64-char hex string");

const admin = createClient(supabaseUrl, supabaseKey);

function decrypt(encrypted: string): string {
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const key = Buffer.from(encryptionKey!, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

interface AmplifierOrder {
  id: string;
  order_id: string; // our order_number
  status: string;
  order_date: string;
  shipments?: {
    tracking_number?: string;
    shipping_method?: string;
    ship_date?: string;
  }[];
}

// Max consecutive pages with zero new matches before stopping early
const MAX_EMPTY_PAGES = 2;

async function fetchRecentAmplifierOrders(authHeader: string, orderNumbers: Set<string>): Promise<AmplifierOrder[]> {
  const allOrders: AmplifierOrder[] = [];
  let page = 1;
  const perPage = 50;
  let emptyStreak = 0;

  while (true) {
    const url = `https://api.amplifier.com/orders?page=${page}&per_page=${perPage}&sort_by=date&sort_direction=desc`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
    });

    if (!res.ok) {
      console.error(`Amplifier API error on page ${page}: ${res.status}`);
      break;
    }

    const json = await res.json();
    const orders: AmplifierOrder[] = json.data || [];

    // Count how many on this page match our unmatched orders
    let matchesOnPage = 0;
    for (const o of orders) {
      const numericId = (o.order_id || "").replace(/^[^0-9]*/, "");
      if (orderNumbers.has(o.order_id) || orderNumbers.has(numericId)) {
        matchesOnPage++;
      }
    }

    allOrders.push(...orders);
    console.log(`  Page ${page}: ${orders.length} orders, ${matchesOnPage} matches (total fetched: ${allOrders.length})`);

    if (matchesOnPage === 0) {
      emptyStreak++;
      if (emptyStreak >= MAX_EMPTY_PAGES) {
        console.log(`  Stopping early — ${MAX_EMPTY_PAGES} consecutive pages with no matches`);
        break;
      }
    } else {
      emptyStreak = 0;
    }

    if (orders.length < perPage || page >= (json.total_pages || 999)) break;
    page++;

    // Rate limit courtesy
    await new Promise(r => setTimeout(r, 200));
  }

  return allOrders;
}

async function main() {
  // Find workspaces with Amplifier configured
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, name, amplifier_api_key_encrypted")
    .not("amplifier_api_key_encrypted", "is", null);

  if (!workspaces?.length) {
    console.log("No workspaces with Amplifier configured.");
    return;
  }

  for (const ws of workspaces) {
    console.log(`\n=== Workspace: ${ws.name} (${ws.id}) ===`);

    const apiKey = await decrypt(ws.amplifier_api_key_encrypted);
    const authHeader = "Basic " + Buffer.from(apiKey + ":").toString("base64");

    // Fetch recent unfulfilled/partial orders missing amplifier_order_id (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: dbOrders } = await admin
      .from("orders")
      .select("id, order_number")
      .eq("workspace_id", ws.id)
      .is("amplifier_order_id", null)
      .gte("created_at", sevenDaysAgo)
      .not("fulfillment_status", "ilike", "fulfilled")
      .not("financial_status", "ilike", "pending");

    if (!dbOrders?.length) {
      console.log("No orders missing Amplifier UUID.");
      continue;
    }

    console.log(`DB orders missing Amplifier UUID: ${dbOrders.length}`);

    // Build set of order numbers for fast lookup
    const orderNumbers = new Set<string>();
    for (const o of dbOrders) {
      if (o.order_number) {
        orderNumbers.add(o.order_number);
        orderNumbers.add(o.order_number.replace(/^[^0-9]*/, ""));
      }
    }

    // Fetch recent orders from Amplifier (stops after 2 consecutive pages with no matches)
    console.log("Fetching recent orders from Amplifier...");
    const ampOrders = await fetchRecentAmplifierOrders(authHeader, orderNumbers);
    console.log(`Total Amplifier orders fetched: ${ampOrders.length}`);

    if (!ampOrders.length) continue;

    // Build a map: order_id (reference) → Amplifier order data
    const ampMap = new Map<string, AmplifierOrder>();
    for (const o of ampOrders) {
      if (o.order_id) ampMap.set(o.order_id, o);
    }

    if (!dbOrders?.length) {
      console.log("No orders missing Amplifier UUID.");
      continue;
    }

    console.log(`DB orders missing Amplifier UUID: ${dbOrders.length}`);

    let matched = 0;
    let shipped = 0;

    for (const dbOrder of dbOrders) {
      const orderNum = dbOrder.order_number || "";

      // Try exact match first, then try stripping common prefixes
      let ampOrder = ampMap.get(orderNum);
      if (!ampOrder) {
        // Try numeric-only match (strip prefix like "SC" or "#")
        const numericOnly = orderNum.replace(/^[^0-9]*/, "");
        ampOrder = ampMap.get(numericOnly);
      }
      if (!ampOrder) {
        // Try with prefix added
        for (const [key, val] of ampMap) {
          if (key.endsWith(orderNum) || orderNum.endsWith(key)) {
            ampOrder = val;
            break;
          }
        }
      }

      if (!ampOrder) continue;

      const update: Record<string, unknown> = {
        amplifier_order_id: ampOrder.id,
        amplifier_status: ampOrder.status,
      };

      // Set received_at from order_date
      if (ampOrder.order_date) {
        update.amplifier_received_at = ampOrder.order_date;
      }

      // If shipped, set shipping info
      const shipment = ampOrder.shipments?.[0];
      if (shipment?.ship_date || ampOrder.status === "Shipped") {
        update.amplifier_shipped_at = shipment?.ship_date || ampOrder.order_date;
        update.amplifier_tracking_number = shipment?.tracking_number || null;
        update.amplifier_carrier = shipment?.shipping_method || null;
        update.amplifier_status = "Shipped";
        shipped++;
      }

      await admin.from("orders").update(update).eq("id", dbOrder.id);
      matched++;
    }

    console.log(`Matched: ${matched} orders (${shipped} already shipped)`);
    console.log(`Unmatched: ${dbOrders.length - matched} orders`);
  }

  console.log("\nDone.");
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
