// Inngest returns functions: process-delivery (auto-dispose after delivery) and issue-refund

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { disposeReturnItems, closeReturn } from "@/lib/shopify-returns";

// ── returns/process-delivery ──
// Triggered when tracking shows delivered. Waits 24h for warehouse inspection,
// then auto-disposes as RESTOCKED and triggers refund flow.

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

    const admin = createAdminClient();

    // Verify the return is in delivered status
    const ret = await step.run("load-return", async () => {
      const { data } = await admin
        .from("returns")
        .select("id, status, resolution_type, shopify_reverse_fulfillment_order_gid")
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!ret || ret.status !== "delivered") {
      return { skipped: true, reason: "Return not in delivered status" };
    }

    // Wait 24 hours for warehouse inspection
    await step.sleep("wait-for-inspection", "24h");

    // Re-check status — might have been manually processed during wait
    const current = await step.run("recheck-status", async () => {
      const { data } = await admin
        .from("returns")
        .select("status")
        .eq("id", return_id)
        .single();
      return data;
    });

    if (!current || current.status !== "delivered") {
      return { skipped: true, reason: "Return status changed during wait" };
    }

    // Auto-dispose as RESTOCKED
    const disposeResult = await step.run("dispose-items", async () => {
      return disposeReturnItems(workspace_id, {
        returnId: return_id,
        disposition: "RESTOCKED",
      });
    });

    if (!disposeResult.success) {
      console.error(`Failed to auto-dispose return ${return_id}:`, disposeResult.error);
      return { error: disposeResult.error };
    }

    // Trigger refund flow
    await step.run("trigger-refund", async () => {
      await inngest.send({
        name: "returns/issue-refund",
        data: { workspace_id, return_id },
      });
    });

    return { success: true, return_id };
  },
);

// ── returns/issue-refund ──
// Triggered after disposal. Issues store credit or closes the return.
// Sends confirmation email. Closes return in Shopify.

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

    const admin = createAdminClient();

    // Load the return with customer info
    const ret = await step.run("load-return", async () => {
      const { data } = await admin
        .from("returns")
        .select(`
          id, status, resolution_type, order_number, net_refund_cents, order_total_cents,
          label_cost_cents, easypost_shipment_id, shopify_return_gid, customer_id,
          customers(email, first_name)
        `)
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!ret) {
      return { error: "Return not found" };
    }

    const customers = ret.customers as unknown as { email: string; first_name: string | null }[] | null;
    const customer = customers?.[0] || null;

    // Check for rate adjustments from EasyPost (adjustments settle by delivery time)
    let finalLabelCostCents = ret.label_cost_cents || 0;
    let finalNetRefundCents = ret.net_refund_cents || 0;

    if (ret.easypost_shipment_id) {
      const adjusted = await step.run("check-rate-adjustment", async () => {
        try {
          const { getActualShippingCost } = await import("@/lib/easypost");
          return getActualShippingCost(workspace_id, ret.easypost_shipment_id);
        } catch (err) {
          console.error("Rate adjustment check failed:", err);
          return null;
        }
      });

      if (adjusted) {
        finalLabelCostCents = adjusted.actualCostCents;
        finalNetRefundCents = (ret.order_total_cents || 0) - finalLabelCostCents;
        if (adjusted.adjusted) {
          console.log(`Rate adjusted for return ${return_id}: quoted ${ret.label_cost_cents}c → actual ${finalLabelCostCents}c`);
        }
      }
    }

    // Update return with final amounts
    await step.run("update-final-amounts", async () => {
      await admin.from("returns").update({
        label_cost_cents: finalLabelCostCents,
        net_refund_cents: finalNetRefundCents,
        updated_at: new Date().toISOString(),
      }).eq("id", return_id);
    });

    // Close the return in Shopify
    const closeResult = await step.run("close-return", async () => {
      return closeReturn(workspace_id, return_id);
    });

    if (!closeResult.success) {
      console.error(`Failed to close return ${return_id}:`, closeResult.error);
    }

    // Update return status
    await step.run("update-status", async () => {
      await admin
        .from("returns")
        .update({
          status: "refunded",
          refunded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", return_id);
    });

    // Send confirmation email
    if (customer?.email) {
      await step.run("send-confirmation", async () => {
        const { sendReturnConfirmationEmail } = await import("@/lib/email");
        await sendReturnConfirmationEmail({
          workspaceId: workspace_id,
          toEmail: customer.email,
          customerName: customer.first_name,
          orderNumber: ret.order_number,
          resolutionType: ret.resolution_type,
        });
      });
    }

    return { success: true, return_id, resolution: ret.resolution_type };
  },
);
