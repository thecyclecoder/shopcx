/**
 * Nightly Delivery Audit — EasyPost tracking check for undelivered orders.
 *
 * Runs at 6 AM Central (11:00 UTC) daily.
 * Checks orders that are fulfilled + not_delivered + 14+ days old.
 *
 * Actions:
 *   delivered → mark delivered
 *   refused → cancel subscription (no ticket)
 *   other RTS → create ticket + assign replacement playbook
 *   failure → create ticket + assign replacement playbook
 *   in_transit 21+ days → dashboard notification for review
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

export const deliveryNightlyAudit = inngest.createFunction(
  {
    id: "delivery-nightly-audit",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 11 * * *" }], // 6 AM Central = 11:00 UTC
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Step 1: Get workspaces with EasyPost configured + not in test mode
    const workspaces = await step.run("get-workspaces", async () => {
      const { data } = await admin.from("workspaces")
        .select("id, easypost_live_api_key_encrypted, easypost_test_mode")
        .not("easypost_live_api_key_encrypted", "is", null);

      return (data || [])
        .filter(w => !w.easypost_test_mode && w.easypost_live_api_key_encrypted)
        .map(w => w.id);
    });

    if (workspaces.length === 0) return { status: "no_workspaces" };

    let totalChecked = 0;
    let totalDelivered = 0;
    let totalRefused = 0;
    let totalRTS = 0;
    let totalFailure = 0;

    for (const workspaceId of workspaces) {
      // Step 2: Get eligible orders for this workspace
      const orders = await step.run(`get-orders-${workspaceId.slice(0, 8)}`, async () => {
        const lookbackDays = 14;
        const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

        const { data } = await admin.from("orders")
          .select("id, order_number, shopify_order_id, customer_id, subscription_id, workspace_id, fulfillments, created_at")
          .eq("workspace_id", workspaceId)
          .eq("fulfillment_status", "FULFILLED")
          .eq("delivery_status", "not_delivered")
          .lte("created_at", cutoff)
          .is("sync_resolved_at", null)
          .order("created_at", { ascending: true })
          .limit(100);

        // Filter to orders with tracking numbers
        return (data || []).filter(o => {
          const fulfillments = (o.fulfillments || []) as { trackingInfo?: { number: string; company?: string }[] }[];
          return fulfillments.some(f => f.trackingInfo?.some(t => t.number));
        }).map(o => {
          const fulfillments = (o.fulfillments || []) as { trackingInfo?: { number: string; company?: string }[] }[];
          const tracking = fulfillments[0]?.trackingInfo?.[0];
          return {
            id: o.id,
            order_number: o.order_number as string,
            shopify_order_id: o.shopify_order_id as string,
            customer_id: o.customer_id as string,
            subscription_id: o.subscription_id as string | null,
            workspace_id: o.workspace_id as string,
            tracking_number: tracking?.number || "",
            carrier: tracking?.company || "USPS",
            created_at: o.created_at as string,
          };
        });
      });

      if (orders.length === 0) continue;

      // Step 3: Check each order (batched in step for durability)
      for (const order of orders) {
        await step.run(`check-${order.order_number}`, async () => {
          totalChecked++;

          try {
            const { lookupTracking } = await import("@/lib/easypost");
            const tracker = await lookupTracking(workspaceId, order.tracking_number, order.carrier);

            const reasonEvent = tracker.status === "return_to_sender"
              ? tracker.events.find(e => e.status === "return_to_sender")
              : null;
            const lastEvent = tracker.events[tracker.events.length - 1];

            // ── Delivered ──
            if (tracker.status === "delivered") {
              totalDelivered++;
              const deliveredEvent = tracker.events.find(e => e.status === "delivered");
              await admin.from("orders").update({
                delivery_status: "delivered",
                delivered_at: deliveredEvent?.datetime || new Date().toISOString(),
              }).eq("id", order.id);
              return;
            }

            // ── Return to sender ──
            if (tracker.status === "return_to_sender") {
              const reason = (reasonEvent?.message || "").toLowerCase();
              const isRefused = reason.includes("refused");

              if (isRefused) {
                totalRefused++;
                // Cancel subscription if active
                if (order.subscription_id) {
                  const { data: sub } = await admin.from("subscriptions")
                    .select("shopify_contract_id, status")
                    .eq("id", order.subscription_id).single();

                  if (sub?.status === "active" && sub.shopify_contract_id) {
                    const { appstleSubscriptionAction } = await import("@/lib/appstle");
                    await appstleSubscriptionAction(
                      workspaceId, sub.shopify_contract_id, "cancel",
                      "Shipment Refused - Auto Cancel", "Delivery Audit",
                    );
                  }
                }

                // Tag in Shopify
                if (order.shopify_order_id) {
                  const { addOrderTags } = await import("@/lib/shopify-order-tags");
                  await addOrderTags(workspaceId, order.shopify_order_id, ["delivery:refused"]);
                }

                await admin.from("orders").update({
                  delivery_status: "returned",
                  sync_resolved_at: new Date().toISOString(),
                  sync_resolved_note: "Refused",
                }).eq("id", order.id);
              } else {
                totalRTS++;
                const detail = reasonEvent?.message || "Unknown";
                const tagSlug = detail.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);

                // Tag in Shopify
                if (order.shopify_order_id) {
                  const { addOrderTags } = await import("@/lib/shopify-order-tags");
                  await addOrderTags(workspaceId, order.shopify_order_id, [`delivery:${tagSlug}`]);
                }

                // Create ticket + assign replacement playbook
                const { data: ticket } = await admin.from("tickets").insert({
                  workspace_id: workspaceId,
                  customer_id: order.customer_id,
                  subject: `Delivery issue — ${order.order_number} (${detail})`,
                  status: "open",
                  channel: "system",
                  tags: ["return-to-sender", `rts:${tagSlug}`, "delivery-audit"],
                }).select("id").single();

                if (ticket) {
                  // Internal note with details
                  await admin.from("ticket_messages").insert({
                    ticket_id: ticket.id,
                    direction: "outbound",
                    visibility: "internal",
                    author_type: "system",
                    body: `[Delivery Audit] Order ${order.order_number} returned to sender: "${detail}". Carrier: ${order.carrier}. Tracking: ${order.tracking_number}. Replacement playbook assigned.`,
                  });

                  // Assign replacement playbook
                  const { data: playbook } = await admin.from("playbooks")
                    .select("id")
                    .eq("workspace_id", workspaceId)
                    .eq("name", "Replacement Order")
                    .eq("is_active", true)
                    .limit(1).single();

                  if (playbook) {
                    await admin.from("tickets").update({
                      active_playbook_id: playbook.id,
                      playbook_step: 0,
                      playbook_context: {
                        easypost_status: tracker.status,
                        easypost_detail: detail,
                        replacement_reason: "delivery_error",
                        customer_error: reason.includes("address"),
                        identified_order_id: order.id,
                        identified_order: order.order_number,
                        tracking_number: order.tracking_number,
                        carrier: order.carrier,
                      },
                      handled_by: "Playbook: Replacement Order",
                    }).eq("id", ticket.id);
                  }
                }

                await admin.from("orders").update({
                  delivery_status: "returned",
                  sync_resolved_at: new Date().toISOString(),
                  sync_resolved_note: detail,
                }).eq("id", order.id);
              }
              return;
            }

            // ── Failure ──
            if (tracker.status === "failure" || tracker.status === "error") {
              totalFailure++;
              const detail = lastEvent?.message || "Carrier failure";

              // Same as non-refused RTS — create ticket + playbook
              const { data: ticket } = await admin.from("tickets").insert({
                workspace_id: workspaceId,
                customer_id: order.customer_id,
                subject: `Delivery failure — ${order.order_number}`,
                status: "open",
                channel: "system",
                tags: ["delivery-failure", "delivery-audit"],
              }).select("id").single();

              if (ticket) {
                await admin.from("ticket_messages").insert({
                  ticket_id: ticket.id,
                  direction: "outbound",
                  visibility: "internal",
                  author_type: "system",
                  body: `[Delivery Audit] Order ${order.order_number} delivery failure: "${detail}". Carrier: ${order.carrier}. Tracking: ${order.tracking_number}.`,
                });

                const { data: playbook } = await admin.from("playbooks")
                  .select("id")
                  .eq("workspace_id", workspaceId)
                  .eq("name", "Replacement Order")
                  .eq("is_active", true)
                  .limit(1).single();

                if (playbook) {
                  await admin.from("tickets").update({
                    active_playbook_id: playbook.id,
                    playbook_step: 0,
                    playbook_context: {
                      easypost_status: tracker.status,
                      easypost_detail: detail,
                      replacement_reason: "carrier_lost",
                      identified_order_id: order.id,
                      identified_order: order.order_number,
                      tracking_number: order.tracking_number,
                      carrier: order.carrier,
                    },
                    handled_by: "Playbook: Replacement Order",
                  }).eq("id", ticket.id);
                }
              }

              await admin.from("orders").update({
                sync_resolved_at: new Date().toISOString(),
                sync_resolved_note: detail,
              }).eq("id", order.id);
              return;
            }

            // ── Still in transit — check if stale (21+ days) ──
            const daysSince = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 86400000);
            if (daysSince >= 21) {
              await admin.from("dashboard_notifications").insert({
                workspace_id: workspaceId,
                type: "system",
                title: `Order ${order.order_number} still in transit after ${daysSince} days`,
                body: `Carrier: ${order.carrier}. Tracking: ${order.tracking_number}. Status: ${tracker.status}.`,
              });
            }

            // No action — check again tomorrow
          } catch (err) {
            console.error(`[delivery-audit] Error checking ${order.order_number}:`, err);
          }

          // Rate limit between lookups
          await new Promise(r => setTimeout(r, 200));
        });
      }
    }

    return {
      checked: totalChecked,
      delivered: totalDelivered,
      refused: totalRefused,
      return_to_sender: totalRTS,
      failure: totalFailure,
    };
  },
);
