// Gateway-aware refund dispatcher.
//
// Every refund entry point in the codebase (returns Inngest, 30-day
// playbook, AI partial_refund, ticket-detail Improve tab, goodwill,
// fraud offsets) must resolve to `refundOrder` — the ONE wrapper that
// asks the order which gateway paid it, then routes the mutation:
//
//   - Internal order (SHOPCX*, no `shopify_order_id`, has
//     `braintree_transaction_id`) → refundBraintreeTransaction()
//     (Braintree API refund of the specific transaction id).
//   - Shopify order (has `shopify_order_id`) → partialRefundByAmount()
//     from `src/lib/shopify-order-actions.ts`, which internally probes
//     the Shopify sale transaction and further re-routes to Braintree
//     when the Shopify gateway is Braintree (the Shopify↔Braintree
//     connection is dead — see the SC128233 phantom-refund incident
//     in shopify-order-actions.ts).
//
// This mirrors the returns Inngest `issue-refund` step (the reference
// implementation documented in docs/brain/lifecycles/return-pipeline.md
// § Phase 4). Phase 3 will migrate every enumerated caller onto this
// wrapper so nothing outside src/lib/refund.ts, shopify-order-actions.ts,
// and integrations/braintree.ts can fire a refund mutation.
//
// Double-refund guard: on success, stamp `refund_id` + `refunded_at`
// on any open (`refunded_at IS NULL`) return for this order in this
// workspace, so the returns pipeline can't refund the customer a
// second time when the product comes back. Same guard as the
// `partial_refund` direct_action in action-executor.ts (added after
// the Sonia Stevens SC132396 double-refund near-miss — see
// docs/brain/operational-rules.md § Returns).
//
// Customer event: on success, write one `order.refunded` row into
// customer_events so the timeline shows the refund + method + reason.

import { createAdminClient } from "@/lib/supabase/admin";
import { refundBraintreeTransaction } from "@/lib/integrations/braintree";
import { partialRefundByAmount } from "@/lib/shopify-order-actions";
import { logCustomerEvent } from "@/lib/customer-events";

export type RefundMethod = "shopify" | "braintree";

// Read-only branch preview — same rule as refundOrder() below, but
// makes no external API calls. Used by scripts/_probe-refund-order.ts
// (Phase 2 verification) and any audit tool that needs to answer
// "which gateway would this order refund through?" without actually
// moving money.
export interface RefundMethodProbe {
  method: RefundMethod | null;
  reason: string;
  order_id?: string;
  shopify_order_id?: string | null;
  braintree_transaction_id?: string | null;
}

export async function resolveRefundMethod(
  workspaceId: string,
  orderId: string,
): Promise<RefundMethodProbe> {
  if (!workspaceId) return { method: null, reason: "workspaceId is required" };
  if (!orderId) return { method: null, reason: "orderId is required" };
  const admin = createAdminClient();
  const { data: order, error } = await admin
    .from("orders")
    .select("id, shopify_order_id, braintree_transaction_id")
    .eq("id", orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return { method: null, reason: `Order lookup failed: ${error.message}` };
  if (!order) return { method: null, reason: `Order ${orderId} not found in workspace` };
  const shopifyOrderId = (order.shopify_order_id ?? null) as string | null;
  const braintreeTxnId = (order.braintree_transaction_id ?? null) as string | null;
  if (!shopifyOrderId) {
    if (!braintreeTxnId) {
      return {
        method: null,
        reason: "Order has no Shopify order or Braintree transaction to refund",
        order_id: order.id,
        shopify_order_id: null,
        braintree_transaction_id: null,
      };
    }
    return {
      method: "braintree",
      reason: "Internal order (no shopify_order_id) — routes to refundBraintreeTransaction",
      order_id: order.id,
      shopify_order_id: null,
      braintree_transaction_id: braintreeTxnId,
    };
  }
  return {
    method: "shopify",
    reason: "Shopify order — routes to partialRefundByAmount (which is itself gateway-aware for Shopify-side Braintree)",
    order_id: order.id,
    shopify_order_id: shopifyOrderId,
    braintree_transaction_id: braintreeTxnId,
  };
}

export interface RefundOrderOptions {
  // Origin of the refund for customer_events.source. Defaults to
  // "system". Callers should set this to their surface — "ai",
  // "agent", "playbook", "inngest", "portal", "fraud", etc.
  source?: string;
  // Explicit customer id for customer_events.customer_id. If omitted,
  // the wrapper resolves it from orders.customer_id.
  customerId?: string | null;
  // Extra properties merged into customer_events.properties for the
  // `order.refunded` row (subscription_id, ticket_id, tier, etc.).
  eventProperties?: Record<string, unknown>;
}

export interface RefundOrderResult {
  success: boolean;
  refund_id?: string;
  method?: RefundMethod;
  error?: string;
  // Set when partialRefundByAmount internally routed to Braintree
  // (Shopify order paid via the Braintree gateway on Shopify) and its
  // Shopify-side reconciliation record didn't land — the caller must
  // reconcile the Shopify order manually.
  needsManualShopifyRecord?: boolean;
}

export async function refundOrder(
  workspaceId: string,
  orderId: string,
  amountCents: number,
  reason: string,
  opts: RefundOrderOptions = {},
): Promise<RefundOrderResult> {
  if (!workspaceId) return { success: false, error: "workspaceId is required" };
  if (!orderId) return { success: false, error: "orderId is required" };
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { success: false, error: `amountCents must be a positive integer (got ${amountCents})` };
  }

  const admin = createAdminClient();

  // Read the order + gateway signals. Scoped to workspace so an
  // orderId from another tenant can't ever surface a refund path.
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, shopify_order_id, braintree_transaction_id, customer_id, order_number")
    .eq("id", orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (orderErr) return { success: false, error: `Order lookup failed: ${orderErr.message}` };
  if (!order) return { success: false, error: `Order ${orderId} not found in workspace` };

  // Mirror of returns.ts § Phase 4: absence of shopify_order_id is
  // the internal-order signal, not the presence of
  // braintree_transaction_id (a Shopify order paid via Braintree
  // gateway on Shopify HAS both — those must still go through the
  // Shopify branch so partialRefundByAmount's gateway probe runs).
  let result: RefundOrderResult;
  if (!order.shopify_order_id) {
    if (!order.braintree_transaction_id) {
      return { success: false, error: "Order has no Shopify order or Braintree transaction to refund" };
    }
    const r = await refundBraintreeTransaction(workspaceId, order.braintree_transaction_id, amountCents);
    result = {
      success: r.success,
      refund_id: r.refundId,
      method: "braintree",
      error: r.error,
    };
  } else {
    const r = await partialRefundByAmount(workspaceId, order.shopify_order_id, amountCents, reason);
    // partialRefundByAmount returns method='shopify' when the
    // refundCreate mutation ran, method='braintree' when it detected
    // the Shopify sale was Braintree-gateway and rerouted. Surface
    // that verbatim so the caller can distinguish (Braintree refund
    // id, manual-reconciliation flag).
    result = {
      success: r.success,
      refund_id: r.braintreeRefundId,
      method: (r.method as RefundMethod | undefined) ?? "shopify",
      error: r.error,
      needsManualShopifyRecord: r.needsManualShopifyRecord,
    };
  }

  if (!result.success) return result;

  // ── Double-refund guard ──
  // Stamp any open return on this order as already-refunded so the
  // returns Inngest issue-refund step skips it. Filtered by
  // workspace_id AND refunded_at IS NULL — a compare-and-set that
  // can't overwrite an already-stamped row or reach across tenants.
  try {
    await admin
      .from("returns")
      .update({
        refund_id: result.refund_id || "direct_refund",
        refunded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", order.id)
      .eq("workspace_id", workspaceId)
      .is("refunded_at", null);
  } catch (e) {
    console.error("[refundOrder] failed to stamp open return(s) as refunded:", e);
  }

  // ── customer_events log ──
  // Best-effort — a log failure never rolls the refund back.
  try {
    const customerId = opts.customerId !== undefined ? opts.customerId : order.customer_id;
    await logCustomerEvent({
      workspaceId,
      customerId: customerId ?? null,
      eventType: "order.refunded",
      source: opts.source ?? "system",
      summary: `Refund $${(amountCents / 100).toFixed(2)} issued via ${result.method} (${reason})`,
      properties: {
        order_id: order.id,
        order_number: order.order_number,
        amount_cents: amountCents,
        method: result.method,
        refund_id: result.refund_id,
        reason,
        ...(opts.eventProperties || {}),
      },
    });
  } catch (e) {
    console.error("[refundOrder] failed to log customer_events row:", e);
  }

  return result;
}
