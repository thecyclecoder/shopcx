// Async Amplifier webhook processing via Inngest
// Webhook route validates token + fires event → this function processes with concurrency control

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const amplifierWebhookProcess = inngest.createFunction(
  {
    id: "amplifier-webhook-process",
    retries: 3,
    concurrency: [{ limit: 5, key: "event.data.workspaceId" }],
    triggers: [{ event: "amplifier/webhook-received" }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { workspaceId, type, data, timestamp } = event.data as {
      workspaceId: string;
      type: string;
      data: {
        id: string;
        reference_id?: string;
        method?: string;
        tracking_number?: string;
        date?: string;
      };
      timestamp: string;
    };

    const admin = createAdminClient();
    const referenceId = data.reference_id;

    if (type === "order.received") {
      if (!referenceId) return { skipped: true, reason: "missing_reference_id" };

      const order = await step.run("match-order-received", async () => {
        const { data: order } = await admin
          .from("orders")
          .select("id, order_number")
          .eq("workspace_id", workspaceId)
          .eq("order_number", `SC${referenceId}`)
          .limit(1)
          .single();
        return order;
      });

      if (!order) return { matched: false, referenceId };

      await step.run("update-order-received", async () => {
        await admin.from("orders")
          .update({
            amplifier_order_id: data.id,
            amplifier_received_at: timestamp,
            amplifier_status: "Processing Shipment",
          })
          .eq("id", order.id);
      });

      return { matched: true, orderId: order.id, type: "received" };
    }

    if (type === "order.shipped") {
      const orderId = await step.run("match-order-shipped", async () => {
        // Try by amplifier_order_id first
        const { data: byAmpId } = await admin
          .from("orders")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("amplifier_order_id", data.id)
          .limit(1)
          .single();

        if (byAmpId) return byAmpId.id;

        // Fallback: match by reference_id → order_number
        if (referenceId) {
          const { data: byRef } = await admin
            .from("orders")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("order_number", `SC${referenceId}`)
            .limit(1)
            .single();
          if (byRef) return byRef.id;
        }

        return null;
      });

      if (!orderId) return { matched: false, referenceId };

      await step.run("update-order-shipped", async () => {
        await admin.from("orders")
          .update({
            amplifier_order_id: data.id,
            amplifier_shipped_at: data.date || timestamp,
            amplifier_tracking_number: data.tracking_number || null,
            amplifier_carrier: data.method || null,
            amplifier_status: "Shipped",
          })
          .eq("id", orderId);
      });

      // Send the customer's "your order shipped" email with tracking.
      // Step-isolated so the email send is idempotent on Inngest retries
      // (and won't fire if it already succeeded once).
      await step.run("email-customer-shipped", async () => {
        const sel = await admin.from("orders")
          .select(
            "id, order_number, email, total_cents, line_items, shipping_address, payment_details, " +
            "shipping_protection_added, shipping_protection_amount_cents, " +
            "amplifier_tracking_number, amplifier_carrier, subscription_id",
          )
          .eq("id", orderId)
          .single();
        if (sel.error || !sel.data) return { skipped: true, reason: "order_fetch_failed" };
        const order = sel.data as unknown as {
          id: string;
          order_number: string;
          email: string | null;
          total_cents: number;
          line_items: Array<{ title: string; variant_title?: string | null; quantity: number; unit_price_cents?: number; price_cents?: number; unit_msrp_cents?: number; line_total_cents?: number; is_gift?: boolean; image_url?: string | null; sku?: string | null }> | null;
          shipping_address: { first_name?: string; last_name?: string; address1?: string; address2?: string | null; city?: string; province_code?: string; zip?: string } | null;
          payment_details: { subtotal_cents?: number; shipping_cents?: number; tax_cents?: number; protection_cents?: number } | null;
          shipping_protection_added: boolean | null;
          shipping_protection_amount_cents: number | null;
          amplifier_tracking_number: string | null;
          amplifier_carrier: string | null;
          subscription_id: string | null;
        };
        if (!order.email) return { skipped: true, reason: "no_email" };
        if (!order.amplifier_tracking_number) return { skipped: true, reason: "no_tracking_number" };
        const { sendShippingNotificationEmail } = await import("@/lib/email-storefront");
        const r = await sendShippingNotificationEmail({
          workspaceId,
          order: {
            id: order.id,
            order_number: order.order_number,
            email: order.email,
            total_cents: order.total_cents,
            line_items: order.line_items || [],
            shipping_address: order.shipping_address,
            payment_details: order.payment_details,
            shipping_protection_added: !!order.shipping_protection_added,
            shipping_protection_amount_cents: order.shipping_protection_amount_cents,
            amplifier_tracking_number: order.amplifier_tracking_number,
            amplifier_carrier: order.amplifier_carrier,
            subscription_id: order.subscription_id,
          },
        });
        if (!r.success) console.warn(`[amplifier-webhook] shipping email failed for order ${orderId}: ${r.error}`);
        return r;
      });

      return { matched: true, orderId, type: "shipped" };
    }

    return { skipped: true, reason: "unknown_event_type", type };
  },
);
