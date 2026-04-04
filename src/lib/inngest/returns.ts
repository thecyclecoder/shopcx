// Inngest functions for returns processing:
// - returns/process-delivery: auto-dispose after delivery
// - returns/issue-refund: issue refund/credit after disposal

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { disposeReturnItems, closeReturn } from "@/lib/shopify-returns";

// ── returns/process-delivery ──
// Triggered when tracking shows delivered. Waits 24h for warehouse inspection, then auto-disposes as RESTOCKED.

export const returnsProcessDelivery = inngest.createFunction(
  {
    id: "returns-process-delivery",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "returns/process-delivery" }],
  },
  async ({ event, step }) => {
    const { workspace_id, return_id } = event.data as {
      workspace_id: string;
      return_id: string;
    };

    // Wait 24 hours for warehouse inspection
    await step.sleep("wait-for-inspection", "24h");

    // Check if return is still in delivered status (not already processed)
    const returnRow = await step.run("check-return-status", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("returns")
        .select("id, status, shopify_reverse_fulfillment_order_gid, workspace_id")
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!returnRow || returnRow.status !== "delivered") {
      return { skipped: true, reason: `Return ${return_id} status is ${returnRow?.status || "not found"}` };
    }

    // Auto-dispose as RESTOCKED
    const disposeResult = await step.run("dispose-items", async () => {
      return disposeReturnItems(workspace_id, {
        returnId: return_id,
        disposition: "RESTOCKED",
        // locationId not provided — Shopify uses default location
      });
    });

    if (!disposeResult.success) {
      console.error(`Failed to auto-dispose return ${return_id}:`, disposeResult.error);
      return { success: false, error: disposeResult.error };
    }

    // Trigger refund flow
    await step.sendEvent("trigger-refund", {
      name: "returns/issue-refund",
      data: { workspace_id, return_id },
    });

    return { success: true, return_id };
  }
);

// ── returns/issue-refund ──
// Triggered after disposal. Issues store credit or closes return. Sends confirmation email.

export const returnsIssueRefund = inngest.createFunction(
  {
    id: "returns-issue-refund",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "returns/issue-refund" }],
  },
  async ({ event, step }) => {
    const { workspace_id, return_id } = event.data as {
      workspace_id: string;
      return_id: string;
    };

    // Load return details
    const returnRow = await step.run("load-return", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("returns")
        .select(`
          id, resolution_type, order_total_cents, label_cost_cents,
          customer_id, order_number, ticket_id,
          customers(email, first_name)
        `)
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!returnRow) {
      return { skipped: true, reason: `Return ${return_id} not found` };
    }

    const netRefund = returnRow.order_total_cents - returnRow.label_cost_cents;
    const isStoreCredit = returnRow.resolution_type.includes("store_credit");

    // Update return with refund info
    await step.run("update-return-refunded", async () => {
      const admin = createAdminClient();
      await admin
        .from("returns")
        .update({
          status: "refunded",
          net_refund_cents: netRefund,
          refunded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", return_id)
        .eq("workspace_id", workspace_id);
    });

    // Close the return in Shopify
    const closeResult = await step.run("close-return", async () => {
      return closeReturn(workspace_id, return_id);
    });

    if (!closeResult.success) {
      console.error(`Failed to close return ${return_id} in Shopify:`, closeResult.error);
    }

    // Send confirmation email if we have customer info
    const customer = returnRow.customers as { email?: string; first_name?: string } | null;
    if (customer?.email) {
      await step.run("send-confirmation", async () => {
        // Create an internal note on the ticket if one exists
        if (returnRow.ticket_id) {
          const admin = createAdminClient();
          const refundLabel = isStoreCredit ? "store credit" : "refund";
          const amountStr = `$${(netRefund / 100).toFixed(2)}`;

          await admin.from("ticket_messages").insert({
            ticket_id: returnRow.ticket_id,
            workspace_id: workspace_id,
            direction: "internal",
            visibility: "internal",
            author_type: "system",
            body_text: `[Returns] ${refundLabel} of ${amountStr} issued for order ${returnRow.order_number}. Return closed.`,
            body_html: `<p>[Returns] ${refundLabel} of ${amountStr} issued for order ${returnRow.order_number}. Return closed.</p>`,
          });
        }
      });
    }

    return {
      success: true,
      return_id,
      resolution: returnRow.resolution_type,
      net_refund_cents: netRefund,
    };
  }
);
