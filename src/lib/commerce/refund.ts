/**
 * commerce/refund.ts — Mutation op for refunds.
 *
 * Thin SDK wrapper that delegates to the underlying gateway-aware
 * dispatcher in [[../refund]] (`refundOrder`). Kept in the commerce/*
 * namespace so every callsite that today reaches into `@/lib/refund`
 * migrates onto `commerce/refund.issueRefund` — the SDK's stable
 * surface — while the low-level dispatcher (Braintree / Shopify branch,
 * double-refund guard, customer_events log) stays a single source of
 * truth in `src/lib/refund.ts`.
 *
 * Shape mirrors the pattern established by
 * [[./subscription]]:`subscriptionSkipNextOrder` — the wrapper takes a
 * stable `(workspaceId, args)` input, delegates to the vendor-aware
 * implementation, and returns a normalized result. `refundOrder` is
 * already internal-vs-Shopify aware (branches on
 * `orders.shopify_order_id`), so `issueRefund` is a signature shim, not
 * a second dispatcher.
 *
 * Do NOT delete `src/lib/refund.ts` — it holds the actual dispatcher
 * that Inngest steps + non-commerce callsites still depend on
 * (see [[../reference/commerce-sdk-inventory]] § Defect register).
 * This wrapper is the SDK-side facade the compiler loop + AI
 * `directActionHandlers.partial_refund` / `.redeem_points_as_refund`
 * consume.
 *
 * The `order_refunds` mirror write from the sibling M1 spec (when it
 * ships) will layer in here (the wrapper is the shared choke point)
 * so every SDK-driven refund also records the mirror row — one
 * commit, one migration point.
 */

import type {
  RefundMethod,
  RefundOrderOptions,
  RefundOrderResult,
} from "@/lib/refund";

export type { RefundMethod } from "@/lib/refund";

/**
 * Args accepted by `issueRefund`. `orderId` is the internal `orders.id`
 * UUID — the wrapper does NOT accept a raw `shopify_order_id` /
 * `order_number` (callers resolve to a UUID first, matching the
 * `refundOrder` boundary). `reason` is required and lands in the
 * customer_events `properties.reason` field.
 */
export interface IssueRefundArgs {
  orderId: string;
  amountCents: number;
  reason: string;
  /** Origin surface for the `customer_events.source` field.
   *  Defaults inside `refundOrder` to `"system"` — every real caller
   *  passes their own ("ai", "agent", "playbook", "inngest", …). */
  source?: string;
  /** Explicit `customer_events.customer_id`. If omitted, `refundOrder`
   *  resolves it from `orders.customer_id`. */
  customerId?: string | null;
  /** Extra properties merged into the `order.refunded` customer_events
   *  row (ticket_id, subscription_id, loyalty_tier, points_spent, …). */
  eventProperties?: Record<string, unknown>;
  /** Read-only branch preview — see [[../refund]]:`RefundOrderOptions.dryRun`.
   *  Runs the order lookup + method resolution, returns `{ success: true,
   *  method, dryRun: true }` with ZERO SDK calls. amountCents may be 0. */
  dryRun?: boolean;
  /** Stable action-identity key threaded down to `RefundOrderOptions.requestKey`.
   *  The Phase 2 handlers derive this from their own action identity
   *  (ticket_id / return_id / replacement_id + order_id + amount + reason)
   *  via [[../refund]] `hashActionRefundKey`, so an Inngest step retry or
   *  self-heal re-drive computes the same key and short-circuits via the
   *  pre-dispatch guard. Omit to let `refundOrder` fall back to the
   *  shape-only `hashRefundRequestKey(order, amount, reason)` default. */
  requestKey?: string;
}

export interface IssueRefundResult {
  success: boolean;
  method?: RefundMethod;
  refund_id?: string;
  error?: string;
  needsManualShopifyRecord?: boolean;
  dryRun?: boolean;
}

/**
 * Issue an order refund through the gateway-aware dispatcher.
 * Delegates to `refundOrder` in [[../refund]], preserving:
 *
 *   - Gateway routing (internal / SHOPCX* → Braintree; Shopify orders
 *     → `partialRefundByAmount` with its own Shopify↔Braintree fallback).
 *   - The double-refund guard (stamps `refunded_at` on any open
 *     `returns` row for this order in this workspace so the returns
 *     Inngest step can't refund the customer a second time).
 *   - The `order.refunded` `customer_events` log write.
 *   - Compare-and-set safety on the workspace scope + open-returns
 *     filter (see [[../refund]] § Double-refund guard).
 *
 * Callers point at this wrapper instead of `@/lib/refund.refundOrder`
 * so the SDK surface stays stable while future layered concerns
 * (order_refunds mirror write, per-workspace policy checks) drop in
 * here without touching every callsite.
 */
export async function issueRefund(
  workspaceId: string,
  args: IssueRefundArgs,
): Promise<IssueRefundResult> {
  if (!workspaceId) return { success: false, error: "workspaceId is required" };
  if (!args.orderId) return { success: false, error: "orderId is required" };

  const { refundOrder } = await import("@/lib/refund");
  const opts: RefundOrderOptions = {
    source: args.source,
    customerId: args.customerId,
    eventProperties: args.eventProperties,
    dryRun: args.dryRun,
    requestKey: args.requestKey,
  };
  const r: RefundOrderResult = await refundOrder(
    workspaceId,
    args.orderId,
    args.amountCents,
    args.reason,
    opts,
  );
  return {
    success: r.success,
    method: r.method,
    refund_id: r.refund_id,
    error: r.error,
    needsManualShopifyRecord: r.needsManualShopifyRecord,
    dryRun: r.dryRun,
  };
}
