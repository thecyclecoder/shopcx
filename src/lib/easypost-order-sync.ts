/**
 * Syncs EasyPost tracking discoveries back to the order record
 * and optionally posts a note on the Shopify order.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { TrackingStatus } from "@/lib/easypost";

interface SyncParams {
  workspaceId: string;
  orderId: string; // our DB order ID
  shopifyOrderId?: string | null;
  trackingResult: TrackingStatus;
}

/**
 * Update an order with EasyPost tracking data.
 * Writes easypost_status, easypost_detail, easypost_location, delivery_status.
 * Posts a note on the Shopify order for agent visibility.
 */
export async function syncEasyPostToOrder(params: SyncParams): Promise<void> {
  const { workspaceId, orderId, shopifyOrderId, trackingResult } = params;
  const admin = createAdminClient();

  // Get the reason event for RTS, or last event otherwise
  const reasonEvent = trackingResult.status === "return_to_sender"
    ? trackingResult.events.find(e => e.status === "return_to_sender")
    : null;
  const lastEvent = trackingResult.events[trackingResult.events.length - 1];
  const detailEvent = reasonEvent || lastEvent;

  const easypostDetail = detailEvent?.message || "";
  const easypostLocation = [detailEvent?.city, detailEvent?.state].filter(Boolean).join(", ");

  // Map EasyPost status to our delivery_status
  let deliveryStatus: string | undefined;
  let deliveredAt: string | undefined;
  if (trackingResult.status === "delivered") {
    deliveryStatus = "delivered";
    const deliveredEvent = trackingResult.events.find(e => e.status === "delivered");
    deliveredAt = deliveredEvent?.datetime || new Date().toISOString();
  } else if (trackingResult.status === "return_to_sender") {
    deliveryStatus = "returned";
  }

  // Update our order record
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {
    easypost_status: trackingResult.status,
    easypost_detail: easypostDetail,
    easypost_location: easypostLocation,
    easypost_checked_at: new Date().toISOString(),
  };

  if (deliveryStatus) updates.delivery_status = deliveryStatus;
  if (deliveredAt) updates.delivered_at = deliveredAt;

  await admin.from("orders").update(updates).eq("id", orderId);

  // Post a note on the Shopify order
  if (shopifyOrderId) {
    try {
      const { getShopifyCredentials } = await import("@/lib/shopify-sync");
      const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
      const { shop, accessToken } = await getShopifyCredentials(workspaceId);

      const noteLines = [
        `EasyPost Tracking Update`,
        `Status: ${trackingResult.status}`,
        easypostDetail ? `Detail: ${easypostDetail}` : null,
        easypostLocation ? `Location: ${easypostLocation}` : null,
        `Checked: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
      ].filter(Boolean).join("\n");

      const mutation = `
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            userErrors { field message }
          }
        }
      `;

      await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: mutation,
          variables: {
            input: {
              id: `gid://shopify/Order/${shopifyOrderId}`,
              note: noteLines,
            },
          },
        }),
      });
    } catch {
      // Non-fatal — Shopify note is a nice-to-have
    }
  }
}
