/**
 * One-time backfill: Query Amplifier API for all orders, match by order_number,
 * and update our DB with amplifier_order_id, amplifier_received_at, amplifier_status,
 * and shipping info if available.
 *
 * Usage: npx tsx scripts/backfill-amplifier-uuids.ts
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// Load encryption key for decrypting Amplifier API key
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY required");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error("Supabase env vars required");

const admin = createClient(supabaseUrl, supabaseKey);

// AES-256-GCM decrypt (mirrors src/lib/crypto.ts)
async function decrypt(encrypted: string): Promise<string> {
  const crypto = await import("crypto");
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const key = Buffer.from(ENCRYPTION_KEY!, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
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

async function fetchAllAmplifierOrders(authHeader: string): Promise<AmplifierOrder[]> {
  const allOrders: AmplifierOrder[] = [];
  let page = 1;
  const perPage = 50;

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
    const orders = json.data || [];
    allOrders.push(...orders);

    console.log(`  Fetched page ${page}: ${orders.length} orders (total: ${allOrders.length})`);

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

    // Fetch all orders from Amplifier
    console.log("Fetching orders from Amplifier...");
    const ampOrders = await fetchAllAmplifierOrders(authHeader);
    console.log(`Total Amplifier orders: ${ampOrders.length}`);

    if (!ampOrders.length) continue;

    // Build a map: order_id (reference) → Amplifier order data
    const ampMap = new Map<string, AmplifierOrder>();
    for (const o of ampOrders) {
      if (o.order_id) ampMap.set(o.order_id, o);
    }

    // Fetch our orders that are missing amplifier_order_id
    const { data: dbOrders } = await admin
      .from("orders")
      .select("id, order_number")
      .eq("workspace_id", ws.id)
      .is("amplifier_order_id", null)
      .not("financial_status", "ilike", "pending");

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
