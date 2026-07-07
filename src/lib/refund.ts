// Gateway-aware refund dispatcher — the ONLY refund entry point.
//
// Every refund path in the codebase (returns Inngest, 30-day playbook
// downstream, AI direct_action, ticket-detail Improve tab, manual
// return-refund route, fraud offsets) resolves to `refundOrder`. It
// asks the order which gateway paid it, then routes the mutation:
//
//   - Internal order (SHOPCX*, no `shopify_order_id`, has
//     `braintree_transaction_id`) → refundBraintreeTransaction()
//     (Braintree API refund of the specific transaction id).
//   - Shopify order (has `shopify_order_id`) → partialRefundByAmount()
//     from `src/lib/shopify-order-actions.ts`. That helper probes the
//     Shopify sale transaction: healthy gateway → Shopify REST refund;
//     Braintree gateway → returns { needsBraintreeFallback: true,
//     braintreeTxnId } so THIS wrapper executes the Braintree refund
//     + recordManualRefund bookkeeping itself (the Shopify↔Braintree
//     connection is dead — SC128233 phantom refund).
//
// Contract with the SDK boundary: `refundBraintreeTransaction` is
// called ONLY from this file and from `src/lib/integrations/braintree.ts`
// (its definition). The Shopify REST refund POST and any Shopify
// refund mutations live ONLY inside `src/lib/shopify-order-actions.ts`.
// Nothing else in the codebase touches a refund mutation.
//
// Double-refund guard: on success, stamp `refund_id` + `refunded_at`
// on any open (`refunded_at IS NULL`) return for this order in this
// workspace, so the returns pipeline can't refund the customer a
// second time when the product comes back. See
// docs/brain/operational-rules.md § Returns (Sonia Stevens SC132396).
//
// Customer event: on success, write one `order.refunded` row into
// customer_events so the timeline shows the refund + method + reason.

import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { refundBraintreeTransaction } from "@/lib/integrations/braintree";
import { partialRefundByAmount, recordManualRefund } from "@/lib/shopify-order-actions";
import { logCustomerEvent } from "@/lib/customer-events";

export type RefundMethod = "shopify" | "braintree";

// Stable idempotency key when the caller doesn't thread its own
// action.request_key through. Same shape → same key → the UNIQUE
// index on (order_id, request_key) short-circuits a retry.
export function hashRefundRequestKey(
  orderId: string,
  amountCents: number,
  reason: string,
): string {
  return createHash("sha256")
    .update(`${orderId}:${amountCents}:${reason || ""}`)
    .digest("hex")
    .slice(0, 32);
}

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
  // Strict dry-run: run only the order lookup + branch resolution,
  // then return `{ success: true, method, dryRun: true }` without
  // firing any SDK call, stamping any return, or writing any
  // customer_events row. Used by `scripts/_verify-refund-dispatcher.ts`
  // to cohort-check that every order still resolves to the right
  // gateway. In dryRun the `amountCents` positional is ignored (0 is
  // legal — the probe never spends money).
  dryRun?: boolean;
  // Idempotency key for the order_refunds mirror. Callers that carry
  // an action-side request id (Sonnet direct_action, playbook step,
  // etc.) should thread it in so a retry can be short-circuited by
  // the Phase 2 verify-by-refund-id lookup. When omitted, the wrapper
  // falls back to a stable hash of (order_id + amount_cents + reason)
  // per the spec — enough for the retry-with-same-shape case but not
  // enough to distinguish two legitimate refunds of the same amount +
  // reason on the same order (the caller MUST pass an explicit key in
  // that case).
  requestKey?: string;
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
  // Set to true when the wrapper returned early from a `dryRun`
  // preview — no SDK call was made, no side effects occurred.
  dryRun?: boolean;
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
  // A live refund must be a positive amount; a dryRun probe is
  // amount-agnostic and callers pass 0 to make that explicit.
  if (!opts.dryRun && (!Number.isFinite(amountCents) || amountCents <= 0)) {
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

  // ── Pre-dispatch idempotency guard ──
  // Compute the stable request_key up front (opts.requestKey when the
  // caller threads its own action id; otherwise the deterministic hash
  // over order_id + amount_cents + reason). Look up the order_refunds
  // ledger for an already-succeeded / already-settled row on the same
  // (workspace, order, key) triple; if present, short-circuit BEFORE
  // any gateway dispatch — the money already moved. This is the
  // choke-point double-refund guard the spec is restoring; the
  // post-success mirror write below plus the DB unique index are the
  // second and third layers, and the open-return stamp handles the
  // orthogonal return-vs-direct collision.
  const requestKey = opts.requestKey || hashRefundRequestKey(order.id, amountCents, reason);
  if (!opts.dryRun) {
    const { data: existing } = await admin
      .from("order_refunds")
      .select("id, vendor, vendor_refund_id")
      .eq("workspace_id", workspaceId)
      .eq("order_id", order.id)
      .eq("request_key", requestKey)
      .in("status", ["succeeded", "settled"])
      .maybeSingle();
    if (existing) {
      return {
        success: true,
        method: (existing.vendor === "braintree" ? "braintree" : "shopify") as RefundMethod,
        refund_id: existing.vendor_refund_id ?? undefined,
      };
    }
  }

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
    if (opts.dryRun) {
      return { success: true, method: "braintree", dryRun: true };
    }
    const r = await refundBraintreeTransaction(workspaceId, order.braintree_transaction_id, amountCents);
    result = {
      success: r.success,
      refund_id: r.refundId,
      method: "braintree",
      error: r.error,
    };
  } else {
    if (opts.dryRun) {
      return { success: true, method: "shopify", dryRun: true };
    }
    const r = await partialRefundByAmount(workspaceId, order.shopify_order_id, amountCents, reason);
    if (r.needsBraintreeFallback && r.braintreeTxnId) {
      // Shopify order paid via the Shopify↔Braintree gateway. Shopify
      // won't refund it (dead connection), so we refund the Braintree
      // transaction directly + record the movement on the Shopify
      // order for reconciliation. Money-first / bookkeeping-second —
      // matches the flow that lived in shopify-order-actions.ts's
      // refundOrderViaBraintree before Phase 3 consolidated it here.
      const bt = await refundBraintreeTransaction(workspaceId, r.braintreeTxnId, amountCents);
      if (!bt.success) {
        result = {
          success: false,
          method: "braintree",
          error: `Braintree refund failed: ${bt.error}`,
        };
      } else {
        const note = `${reason} — refunded via Braintree (txn ${bt.refundId || r.braintreeTxnId})`;
        const rec = await recordManualRefund(workspaceId, order.shopify_order_id, amountCents, note);
        result = {
          success: true,
          refund_id: bt.refundId,
          method: "braintree",
          needsManualShopifyRecord: !rec.success,
          error: rec.success ? undefined : `Braintree refund succeeded but Shopify record failed: ${rec.error}`,
        };
      }
    } else {
      result = {
        success: r.success,
        method: (r.method as RefundMethod | undefined) ?? "shopify",
        error: r.error,
        needsManualShopifyRecord: r.needsManualShopifyRecord,
      };
    }
  }

  if (!result.success) return result;

  // ── order_refunds mirror (write-on-fire) ──
  // Refund-integrity Phase 1: after the vendor call succeeds, insert
  // one row into public.order_refunds keyed on
  // request_key = coalesce(opts.requestKey, hash(order_id + amount_cents + reason)).
  // The UNIQUE index on (order_id, request_key) is the DB-level
  // backstop: a duplicate insert (same-shape retry, or the racing
  // second attempt Phase 2's verify-by-refund-id will short-circuit
  // once it lands) fails the unique constraint and lands in this
  // try/catch. Best-effort: a mirror insert failure never rolls the
  // refund back (the money already moved) — logged for the Phase 3
  // T+3d reconcile to catch.
  try {
    await admin.from("order_refunds").insert({
      workspace_id: workspaceId,
      order_id: order.id,
      request_key: requestKey,
      vendor: result.method === "braintree" ? "braintree" : "shopify",
      vendor_refund_id: result.refund_id ?? null,
      amount_cents: amountCents,
      status: "succeeded",
    });
  } catch (e) {
    console.error("[refundOrder] failed to write order_refunds mirror row:", e);
  }

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
