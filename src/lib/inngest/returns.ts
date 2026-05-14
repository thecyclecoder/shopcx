// Inngest returns pipeline:
//   returns/process-delivery → fires returns/issue-refund instantly
//   returns/issue-refund     → reads stored net_refund_cents, refunds
//                              or issues store credit, closes return,
//                              emails customer. Escalates if amount
//                              missing — never auto-refunds $0.
//
// Design notes:
//   - Dispose (Shopify reverseFulfillmentOrderDispose) was previously
//     gating the refund. We don't use Shopify's inventory bookkeeping
//     for returns, so it was pure dead weight that blocked refunds
//     when older returns lacked reverse fulfillment line item IDs.
//   - The 24-hour inspection wait was for that dispose step. With
//     dispose gone, the refund fires as soon as EasyPost confirms
//     delivery. Customer experience > inventory accounting.
//   - The refund amount is the value STORED on the return row at
//     create time (computed from items + label policy + resolution
//     type). The pipeline never re-derives it — if it's missing or
//     zero, that's a creation-time bug, surfaced as a dashboard
//     notification.

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { closeReturn } from "@/lib/shopify-returns";

// ── returns/process-delivery ──
// Triggered by EasyPost webhook when tracker → delivered. Verifies
// status and instantly fires the refund event. No 24h wait. No
// dispose. We don't tell Shopify what to do with the physical items.

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

    const ret = await step.run("load-return", async () => {
      const { data } = await admin
        .from("returns")
        .select("id, status, refunded_at, refund_id")
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!ret) return { skipped: true, reason: "Return not found" };
    if (ret.status !== "delivered") {
      return { skipped: true, reason: `Status is ${ret.status}, not delivered` };
    }
    if (ret.refunded_at || ret.refund_id) {
      return { skipped: true, reason: "Already refunded" };
    }

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
// Reads the stored amount, branches refund vs store credit, closes
// the Shopify return, sends customer confirmation. Trusts net_refund_cents
// as the contract; if it's missing/zero, surfaces a notification and
// stops — does NOT auto-refund full or guess at the amount.

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

    const ret = await step.run("load-return", async () => {
      const { data } = await admin
        .from("returns")
        .select(`
          id, status, resolution_type, order_number, order_id,
          net_refund_cents, refund_id, customer_id,
          customers(email, first_name)
        `)
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!ret) return { error: "Return not found" };
    if (ret.refund_id) return { skipped: true, reason: "Already has refund_id" };

    const amountCents = ret.net_refund_cents || 0;

    // If no amount stored, escalate. Never auto-refund $0 and never
    // guess the amount from the order — the amount is context-dependent
    // (full vs partial, label deducted or not) and has to come from
    // the return-creation step that knew the context.
    if (amountCents <= 0) {
      await step.run("notify-missing-amount", async () => {
        await admin.from("dashboard_notifications").insert({
          workspace_id,
          type: "system",
          title: `Return needs manual review — no refund amount stored`,
          body: `Return ${ret.order_number} was delivered but net_refund_cents is ${amountCents}. Set the amount on the return row, then re-fire returns/issue-refund with { workspace_id, return_id: ${return_id} }.`,
          metadata: { type: "return_missing_amount", return_id, order_number: ret.order_number },
        });
      });
      return { needs_review: true, reason: "net_refund_cents missing" };
    }

    const customersRel = ret.customers as unknown as { email: string; first_name: string | null }[] | { email: string; first_name: string | null } | null;
    const customer = Array.isArray(customersRel) ? customersRel[0] : customersRel;

    const isStoreCredit = (ret.resolution_type || "").includes("store_credit");
    let valueIssued = false;
    let issuedSummary = "";

    if (isStoreCredit) {
      const creditResult = await step.run("issue-store-credit", async (): Promise<{ ok: boolean; balance: number; transactionId: string | null; error?: string }> => {
        const { data: cust } = await admin.from("customers")
          .select("shopify_customer_id").eq("id", ret.customer_id).maybeSingle();
        if (!cust?.shopify_customer_id) {
          return { ok: false, balance: 0, transactionId: null, error: "Customer has no Shopify ID" };
        }
        const { issueStoreCredit } = await import("@/lib/store-credit");
        return issueStoreCredit({
          workspaceId: workspace_id,
          customerId: ret.customer_id,
          shopifyCustomerId: cust.shopify_customer_id,
          amount: amountCents / 100,
          reason: `Return ${ret.order_number} delivered — store credit issued`,
          issuedBy: "system",
          issuedByName: "ShopCX (auto)",
        });
      });
      if (creditResult.ok) {
        valueIssued = true;
        issuedSummary = `Store credit $${(amountCents / 100).toFixed(2)} issued`;
        await admin.from("returns").update({
          refund_id: creditResult.transactionId,
          updated_at: new Date().toISOString(),
        }).eq("id", return_id);
      } else {
        await step.run("notify-credit-failed", async () => {
          await admin.from("dashboard_notifications").insert({
            workspace_id,
            type: "system",
            title: `Store credit issuance failed — manual action needed`,
            body: `Return ${return_id} (${ret.order_number}) was delivered but storeCreditAccountCredit failed: ${creditResult.error}`,
            metadata: { type: "return_credit_failed", return_id, error: creditResult.error },
          });
        });
      }
    } else {
      const refundResult = await step.run("issue-refund", async () => {
        const { data: order } = await admin.from("orders")
          .select("shopify_order_id").eq("id", ret.order_id).single();
        if (!order?.shopify_order_id) return { success: false, error: "Order not found" };
        const { partialRefundByAmount } = await import("@/lib/shopify-order-actions");
        return partialRefundByAmount(
          workspace_id,
          order.shopify_order_id,
          amountCents,
          `Return ${ret.order_number} delivered`,
        );
      });
      if (refundResult.success) {
        valueIssued = true;
        issuedSummary = `Refund $${(amountCents / 100).toFixed(2)} issued via Shopify`;
      } else {
        await step.run("notify-refund-failed", async () => {
          await admin.from("dashboard_notifications").insert({
            workspace_id,
            type: "system",
            title: `Return refund failed — manual action needed`,
            body: `Return ${return_id} (${ret.order_number}) was delivered but Shopify refundCreate failed: ${refundResult.error}`,
            metadata: { type: "return_refund_failed", return_id, error: refundResult.error },
          });
        });
      }
    }

    // Close the Shopify return record (purely cosmetic on their side —
    // marks it as fully resolved).
    await step.run("close-return", async () => {
      const r = await closeReturn(workspace_id, return_id);
      if (!r.success) {
        console.error(`closeReturn failed for ${return_id}:`, r.error);
      }
    });

    // Update local status. Only mark refunded if money actually moved.
    await step.run("update-status", async () => {
      const updates: Record<string, string> = {
        status: valueIssued ? "refunded" : "delivered",
        updated_at: new Date().toISOString(),
      };
      if (valueIssued) updates.refunded_at = new Date().toISOString();
      await admin.from("returns").update(updates).eq("id", return_id);
    });

    // Confirmation email only if value moved.
    if (customer?.email && valueIssued) {
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

    return { success: valueIssued, return_id, summary: issuedSummary };
  },
);
