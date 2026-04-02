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

      return { matched: true, orderId, type: "shipped" };
    }

    return { skipped: true, reason: "unknown_event_type", type };
  },
);
