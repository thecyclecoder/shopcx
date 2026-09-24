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
import { errText } from "@/lib/error-text";

export type RefundMethod = "shopify" | "braintree";

// Stable idempotency key when the caller doesn't thread its own
// action.request_key through. Same (order, amount) → same key → the
// UNIQUE index on (order_id, request_key) short-circuits a retry.
//
// The reason text is intentionally NOT part of the identity — the pre-
// merge behavior folded the free-text reason into the hash, so a re-
// worded second attempt at the same refund produced a different key
// and only the gateway itself blocked the double refund (SHOPCX373,
// 2026-09-24 near-miss). The reason is now recorded context on the
// ledger row, not an ingredient of what makes a refund unique.
//
// Two GENUINELY distinct partial refunds of the same amount on one
// order are still legitimate (two $20 goodwill credits); the caller
// signals that with an explicit `attempt` ordinal (or by threading an
// action-side `requestKey` through). The default path is safe; a
// deliberate second identical refund must be explicit.
export function hashRefundRequestKey(
  orderId: string,
  amountCents: number,
  _reason?: string,
  attempt?: number | string,
): string {
  const key =
    attempt !== undefined && attempt !== null && String(attempt).length > 0
      ? `${orderId}:${amountCents}:attempt=${attempt}`
      : `${orderId}:${amountCents}`;
  return createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32);
}

// Stable action-identity key — the Phase 2 key handlers thread down
// from the caller side. Scopes the request to the ACTION that fired
// (a ticket, a returns row, a replacement), so two different tickets
// legitimately refunding the same shape get distinct keys via their
// actor id and both fire; a retry of the SAME action (Inngest step
// retry, self-heal re-drive) computes the same key and short-circuits
// via the pre-dispatch guard. The reason text is intentionally NOT
// part of the identity here either — a re-worded retry of the same
// action must still short-circuit (Phase 3 of docs/brain/specs/
// a-braintree-side-refund-must-reach-our-books.md — same principle
// as hashRefundRequestKey above).
export function hashActionRefundKey(
  actorScope: string,
  actorId: string,
  orderId: string,
  amountCents: number,
  _reason?: string,
): string {
  return createHash("sha256")
    .update(`${actorScope}:${actorId}:${orderId}:${amountCents}`)
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

// ── orders.financial_status derive-and-set ──
// The ONE writer of `orders.financial_status` from the refund ledger.
// Everything that mirrors a refund (refundOrder above, vendor-refund-mirror,
// the reconcile backfill scripts/_backfill-order-refund-status-from-ledger.ts)
// funnels through this routine — the spec requires ONE writer so nothing can
// silently disagree with the ledger.
//
// Rules preserved from the block that used to live inline in refundOrder:
//   - Sum only `succeeded`/`settled` order_refunds rows.
//   - refundedTotalCents >= total_cents ⇒ 'refunded'.
//   - Any lesser positive sum ⇒ 'partially_refunded'.
//   - A positive sum on an order with no total_cents ⇒ 'refunded'.
//   - Case-insensitive comparison against the currently-stored column
//     (prod carries both `PAID` and `paid`), always write lowercase.
//   - Never regress a stronger vendor-stamped state:
//     `refunded` (2) > `partially_refunded` (1) > everything else (0).
//     The write only fires when the derived weight is STRICTLY greater.
//
// Best-effort at the caller: this NEVER throws (any DB error is captured
// in `error`). refundOrder logs the error and returns success — the money
// already moved and the mirror row is what the ledger cares about.
export interface DeriveOrderRefundStatusResult {
  ok: boolean;
  error?: string;
  updated?: boolean;
  from?: string | null;
  to?: "refunded" | "partially_refunded" | null;
  refunded_cents?: number;
  total_cents?: number;
}

// Pure predicate used by `deriveAndSetOrderRefundStatus` and the
// reconcile backfill script. Returns the state the column SHOULD be
// stamped to, or `null` when the current stored state already covers
// the ledger (never regress a stronger state, never no-write-needed
// churn a row). All the rules above live here in one place so the
// derive routine and any auditor read the identical decision.
export function decideRefundStatusFromLedger(input: {
  refundedCents: number;
  totalCents: number;
  currentStatus: string | null | undefined;
}): "refunded" | "partially_refunded" | null {
  const refundedCents = Number(input.refundedCents) || 0;
  const totalCents = Number(input.totalCents) || 0;
  let derived: "refunded" | "partially_refunded" | null = null;
  if (refundedCents > 0 && totalCents > 0) {
    derived = refundedCents >= totalCents ? "refunded" : "partially_refunded";
  } else if (refundedCents > 0) {
    derived = "refunded";
  }
  if (!derived) return null;
  const weight: Record<string, number> = { refunded: 2, partially_refunded: 1 };
  const currentWeight = weight[String(input.currentStatus ?? "").toLowerCase()] ?? 0;
  const nextWeight = weight[derived] ?? 0;
  return nextWeight > currentWeight ? derived : null;
}

export async function deriveAndSetOrderRefundStatus(
  workspaceId: string,
  orderId: string,
): Promise<DeriveOrderRefundStatusResult> {
  if (!workspaceId) return { ok: false, error: "workspaceId is required" };
  if (!orderId) return { ok: false, error: "orderId is required" };
  const admin = createAdminClient();
  try {
    const { data: order, error: orderErr } = await admin
      .from("orders")
      .select("id, total_cents, financial_status")
      .eq("workspace_id", workspaceId)
      .eq("id", orderId)
      .maybeSingle();
    if (orderErr) return { ok: false, error: `Order lookup failed: ${orderErr.message}` };
    if (!order) return { ok: false, error: `Order ${orderId} not found in workspace` };

    const { data: ledger, error: ledgerErr } = await admin
      .from("order_refunds")
      .select("amount_cents, status")
      .eq("workspace_id", workspaceId)
      .eq("order_id", order.id)
      .in("status", ["succeeded", "settled"]);
    if (ledgerErr) return { ok: false, error: `Ledger lookup failed: ${ledgerErr.message}` };

    const refundedTotalCents = (ledger || []).reduce(
      (sum, r) => sum + (Number((r as { amount_cents?: number }).amount_cents) || 0),
      0,
    );
    const totalCents = Number(order.total_cents) || 0;

    const nextStatus = decideRefundStatusFromLedger({
      refundedCents: refundedTotalCents,
      totalCents,
      currentStatus: order.financial_status,
    });

    if (!nextStatus) {
      return {
        ok: true,
        updated: false,
        from: order.financial_status ?? null,
        to: null,
        refunded_cents: refundedTotalCents,
        total_cents: totalCents,
      };
    }

    const { error: updateErr } = await admin
      .from("orders")
      .update({ financial_status: nextStatus })
      .eq("workspace_id", workspaceId)
      .eq("id", order.id);
    if (updateErr) return { ok: false, error: `Order update failed: ${updateErr.message}` };
    return {
      ok: true,
      updated: true,
      from: order.financial_status ?? null,
      to: nextStatus,
      refunded_cents: refundedTotalCents,
      total_cents: totalCents,
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
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
  // falls back to a stable hash of (order_id + amount_cents [+ attempt]).
  // The hash does NOT include the reason text — a re-worded retry of
  // the same refund must be recognised as the same refund and refused
  // by us (Phase 3, docs/brain/specs/a-braintree-side-refund-must-reach-our-books.md).
  requestKey?: string;
  // Explicit attempt ordinal for a GENUINELY deliberate second refund
  // of the same amount on the same order (two separate $20 goodwill
  // credits, for example). When set, it is folded into the identity
  // hash so the intended second refund does not collide with the
  // first — the same discipline as the dunning charge path's
  // caller-held attempt ordinal. The default path (attempt omitted)
  // is the safe one: same (order, amount) hashes the same key and
  // the pre-dispatch guard blocks the second attempt.
  attempt?: number | string;
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
  // Set to true when a refund is already in flight on the order (a pending
  // gateway refund, e.g. PayPal settling over a few days). No new refund was
  // issued — the caller should surface "already processing", not a hard error.
  alreadyPending?: boolean;
  // Set to true when the pre-dispatch idempotency guard matched an
  // already-succeeded / already-settled ledger row on the same
  // (order, amount [+ attempt]) identity, so no new refund was fired.
  // The caller MUST distinguish this from a fresh refund — surfacing it
  // as "the refund already happened; not issuing a second one" rather
  // than a bare gateway-error string. `refund_id` still carries the
  // first fire's id so a caller can present it.
  blockedDuplicate?: boolean;
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
  // total_cents + financial_status feed the post-success derive-and-set
  // of the order's payment state from the refund ledger below.
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, shopify_order_id, braintree_transaction_id, customer_id, order_number, total_cents, financial_status")
    .eq("id", orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (orderErr) return { success: false, error: `Order lookup failed: ${orderErr.message}` };
  if (!order) return { success: false, error: `Order ${orderId} not found in workspace` };

  // ── Pre-dispatch idempotency guard ──
  // Compute the stable request_key up front (opts.requestKey when the
  // caller threads its own action id; otherwise the deterministic hash
  // over (order_id, amount_cents [, attempt])). The reason text is NOT
  // part of the identity — a re-worded retry of the same refund hashes
  // the same key so we refuse to re-fire, and only a caller-supplied
  // `attempt` ordinal can request a deliberate second identical refund
  // (Phase 3, docs/brain/specs/a-braintree-side-refund-must-reach-our-books.md).
  //
  // Look up the order_refunds ledger for an already-succeeded /
  // already-settled row on the same (workspace, order, key) triple; if
  // present, short-circuit BEFORE any gateway dispatch — the money
  // already moved. Return `blockedDuplicate: true` so the caller can
  // surface "the refund already happened" rather than a bare error
  // that reads like a gateway failure.
  const requestKey =
    opts.requestKey || hashRefundRequestKey(order.id, amountCents, reason, opts.attempt);
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
        blockedDuplicate: true,
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
        alreadyPending: r.alreadyPending,
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

  // ── orders.financial_status derive-and-set ──
  // The mirror row for THIS refund has just landed. Delegate to the
  // exported chokepoint so this path and the reconcile backfill agree
  // byte-for-byte (see deriveAndSetOrderRefundStatus above for the rules).
  const derived = await deriveAndSetOrderRefundStatus(workspaceId, order.id);
  if (!derived.ok) {
    console.error("[refundOrder] failed to derive-and-set orders.financial_status:", derived.error);
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
