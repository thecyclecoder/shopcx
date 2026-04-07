/**
 * EasyPost Delivery Audit Script
 *
 * Looks up tracking status via EasyPost for orders that:
 *   - Are fulfilled with a tracking number
 *   - Have delivery_status = "not_delivered"
 *   - Were created 14+ days ago
 *
 * Actions:
 *   - delivered → update delivery_status + delivered_at
 *   - return_to_sender + "Refused" → cancel linked subscription
 *   - return_to_sender + other reason → log for replacement (playbook TBD)
 *   - in_transit / failure → log for review
 *
 * Usage:
 *   ENCRYPTION_KEY=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/easypost-delivery-audit.ts [--dry-run] [--days 14]
 */

import { createClient } from "@supabase/supabase-js";
import EasyPostClient from "@easypost/api";

// ── Config ──

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const lookbackDays = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 14 : 14;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const encryptionKey = process.env.ENCRYPTION_KEY!;

if (!supabaseUrl || !supabaseKey || !encryptionKey) {
  console.error("Missing required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY");
  process.exit(1);
}

const admin = createClient(supabaseUrl, supabaseKey);

// ── Crypto (inline to avoid import path issues in scripts) ──

import crypto from "crypto";

function decrypt(encrypted: string): string {
  const [ivHex, authTagHex, cipherHex] = encrypted.split(":");
  const key = Buffer.from(encryptionKey, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(cipherHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── Main ──

interface OrderRow {
  id: string;
  order_number: string;
  shopify_order_id: string | null;
  email: string;
  created_at: string;
  subscription_id: string | null;
  customer_id: string | null;
  workspace_id: string;
  fulfillments: { trackingInfo?: { number: string; company?: string }[] }[];
}

// ── Shopify order tagging (inline to avoid import path issues) ──

let shopifyCredsCache: { shop: string; accessToken: string } | null = null;

async function getShopifyCreds(workspaceId: string) {
  if (shopifyCredsCache) return shopifyCredsCache;
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.shopify_access_token_encrypted) return null;
  shopifyCredsCache = { shop: ws.shopify_myshopify_domain, accessToken: decrypt(ws.shopify_access_token_encrypted) };
  return shopifyCredsCache;
}

async function tagShopifyOrder(workspaceId: string, shopifyOrderId: string, tags: string[]) {
  const creds = await getShopifyCreds(workspaceId);
  if (!creds) return;
  const gid = `gid://shopify/Order/${shopifyOrderId}`;
  const mutation = `mutation { tagsAdd(id: "${gid}", tags: ${JSON.stringify(tags)}) { userErrors { message } } }`;
  await fetch(`https://${creds.shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": creds.accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation }),
  });
}

async function main() {
  console.log(`\n🔍 EasyPost Delivery Audit — ${dryRun ? "DRY RUN" : "LIVE"} — lookback: ${lookbackDays} days\n`);

  // Get the EasyPost live key
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, easypost_live_api_key_encrypted, easypost_test_api_key_encrypted, easypost_test_mode")
    .limit(1)
    .single();

  if (!ws) {
    console.error("No workspace found");
    process.exit(1);
  }

  const keyEncrypted = ws.easypost_test_mode
    ? ws.easypost_test_api_key_encrypted
    : ws.easypost_live_api_key_encrypted;

  if (!keyEncrypted) {
    console.error(`No EasyPost ${ws.easypost_test_mode ? "test" : "live"} API key configured`);
    process.exit(1);
  }

  const easypost = new EasyPostClient(decrypt(keyEncrypted));
  console.log(`Using EasyPost ${ws.easypost_test_mode ? "TEST" : "LIVE"} key\n`);

  // Find orders: fulfilled, not delivered, 14+ days old, has tracking
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: orders, error } = await admin
    .from("orders")
    .select("id, order_number, shopify_order_id, email, created_at, subscription_id, customer_id, workspace_id, fulfillments")
    .eq("fulfillment_status", "FULFILLED")
    .eq("delivery_status", "not_delivered")
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Query error:", error.message);
    process.exit(1);
  }

  // Filter to orders with tracking numbers
  const trackableOrders: (OrderRow & { trackingNumber: string; carrier: string })[] = [];
  for (const o of (orders || []) as OrderRow[]) {
    for (const f of o.fulfillments || []) {
      const t = f.trackingInfo?.[0];
      if (t?.number) {
        trackableOrders.push({ ...o, trackingNumber: t.number, carrier: t.company || "USPS" });
        break;
      }
    }
  }

  console.log(`Found ${trackableOrders.length} orders to check\n`);
  if (trackableOrders.length === 0) return;

  // Stats
  const stats = { delivered: 0, refused: 0, return_to_sender_other: 0, in_transit: 0, failure: 0, error: 0 };

  for (const order of trackableOrders) {
    process.stdout.write(`${order.order_number} (${order.carrier} ${order.trackingNumber}) ... `);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tracker = await easypost.Tracker.create({
        tracking_code: order.trackingNumber,
        carrier: order.carrier,
      } as any);

      const status = tracker.status || "unknown";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = (tracker.tracking_details || []) as any[];
      const lastEvent = events[events.length - 1];
      const lastMessage = lastEvent?.message || "";
      const lastLocation = [lastEvent?.tracking_location?.city, lastEvent?.tracking_location?.state].filter(Boolean).join(", ");

      console.log(`${status} — "${lastMessage}" at ${lastLocation || "?"}`);

      // ── Handle by status ──

      if (status === "delivered") {
        stats.delivered++;
        const deliveredEvent = events.find((e: any) => e.status === "delivered");
        const deliveredAt = deliveredEvent?.datetime || new Date().toISOString();

        if (!dryRun) {
          await admin.from("orders").update({
            delivery_status: "delivered",
            delivered_at: deliveredAt,
          }).eq("id", order.id);
        }
        console.log(`  → ${dryRun ? "[DRY RUN] Would mark" : "Marked"} as delivered (${deliveredAt})`);
      }

      else if (status === "return_to_sender") {
        // Find the reason (first RTS event)
        const reasonEvent = events.find((e: any) => e.status === "return_to_sender");
        const reason = (reasonEvent?.message || lastMessage || "").toLowerCase();
        const isRefused = reason.includes("refused");

        if (isRefused) {
          stats.refused++;
          console.log(`  → REFUSED — checking for active subscription...`);

          if (order.subscription_id) {
            const { data: sub } = await admin
              .from("subscriptions")
              .select("shopify_contract_id, status")
              .eq("id", order.subscription_id)
              .single();

            if (sub?.status === "active" && sub.shopify_contract_id) {
              if (!dryRun) {
                // Cancel via Appstle
                const { data: wsCreds } = await admin
                  .from("workspaces")
                  .select("appstle_api_key_encrypted, shopify_myshopify_domain")
                  .eq("id", order.workspace_id)
                  .single();

                if (wsCreds?.appstle_api_key_encrypted) {
                  const appstleKey = decrypt(wsCreds.appstle_api_key_encrypted);
                  const params = new URLSearchParams({
                    cancellationFeedback: "Shipment Refused - Auto Cancel",
                    cancellationNote: "Cancelled by Delivery Audit — shipment refused at delivery",
                  });
                  const endpoint = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/${sub.shopify_contract_id}?${params}`;
                  const res = await fetch(endpoint, {
                    method: "DELETE",
                    headers: { "X-API-Key": appstleKey },
                  });

                  if (res.ok || res.status === 204) {
                    await admin.from("subscriptions").update({
                      status: "cancelled",
                      updated_at: new Date().toISOString(),
                    }).eq("id", order.subscription_id);
                    console.log(`  → Subscription ${sub.shopify_contract_id} CANCELLED`);
                  } else {
                    console.log(`  → Subscription cancel FAILED: ${res.status}`);
                  }
                }
              } else {
                console.log(`  → [DRY RUN] Would cancel subscription ${sub.shopify_contract_id}`);
              }
            } else {
              console.log(`  → Subscription not active (${sub?.status || "not found"})`);
            }
          } else {
            console.log(`  → No subscription linked`);
          }

          // Mark order as returned + tag in Shopify
          if (!dryRun) {
            await admin.from("orders").update({
              delivery_status: "returned",
              sync_resolved_at: new Date().toISOString(),
              sync_resolved_note: "Refused",
            }).eq("id", order.id);

            if (order.shopify_order_id) {
              await tagShopifyOrder(order.workspace_id, order.shopify_order_id, ["delivery:refused"]);
              console.log(`  → Shopify tagged: delivery:refused`);
            }
          }
        } else {
          stats.return_to_sender_other++;
          const reasonMsg = reasonEvent?.message || "unknown reason";
          const tagSlug = reasonMsg.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
          console.log(`  → RETURN TO SENDER (${reasonMsg}) — replacement playbook TBD`);

          // TODO: Create ticket + start replacement order playbook
          // if (!dryRun) {
          //   // Create ticket for customer
          //   // Assign replacement playbook
          //   // Tag with return-to-sender + reason
          // }

          if (!dryRun) {
            await admin.from("orders").update({
              delivery_status: "returned",
              sync_resolved_at: new Date().toISOString(),
              sync_resolved_note: reasonMsg,
            }).eq("id", order.id);

            if (order.shopify_order_id) {
              await tagShopifyOrder(order.workspace_id, order.shopify_order_id, [`delivery:${tagSlug}`]);
              console.log(`  → Shopify tagged: delivery:${tagSlug}`);
            }
          }
        }
      }

      else if (status === "failure" || status === "error") {
        stats.failure++;
        console.log(`  → FAILURE — ${lastMessage}`);
        // TODO: Same as return_to_sender_other — create ticket + replacement playbook
      }

      else {
        // in_transit, out_for_delivery, pre_transit, unknown
        stats.in_transit++;
        console.log(`  → Still ${status}, no action needed`);
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      stats.error++;
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  console.log(`\n${"═".repeat(50)}`);
  console.log(`SUMMARY${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`${"═".repeat(50)}`);
  console.log(`  Delivered:            ${stats.delivered}`);
  console.log(`  Refused (cancelled):  ${stats.refused}`);
  console.log(`  RTS other (TBD):      ${stats.return_to_sender_other}`);
  console.log(`  Still in transit:     ${stats.in_transit}`);
  console.log(`  Failure:              ${stats.failure}`);
  console.log(`  Errors:               ${stats.error}`);
  console.log(`  Total checked:        ${trackableOrders.length}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
