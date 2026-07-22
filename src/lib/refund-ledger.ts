/**
 * refund-ledger — LIVE refundable-balance read for a Shopify order.
 *
 * Answers the one question that dissolves the SC133086 escalation class:
 * what is ACTUALLY still refundable on this order right now, per Shopify?
 *
 * Every consumer (Sol first-touch, June's escalation brief, the self-healing
 * return sweep) needs the SAME primitive, so the gateway is the source of
 * truth — not our local `order_refunds` mirror (which is only ever written
 * when our own code fires the refund, so an out-of-band refund issued
 * directly in Shopify is invisible to it and makes the balance math lie).
 *
 * STRICTLY READ-ONLY. This module issues no refunds and writes no rows.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { findPendingRefundTxn, type ShopifyTxnLite } from "@/lib/shopify-order-actions";

export interface RefundLedgerLine {
  amountCents: number;
  gateway: string | null;
  processedAt: string | null;
  status: "success" | "pending" | "failure" | "error" | "other";
  /** True when a row in public.order_refunds matches this Shopify refund by amount. */
  mirroredLocally: boolean;
}

export type OrderRefundLedger =
  | {
      ok: true;
      /** Sum of successful `kind='sale'` / `kind='capture'` transactions on the order, in cents. */
      saleCents: number;
      /** Sum of successful `kind='refund'` transactions, in cents. */
      refundedCents: number;
      /** Sum of `kind='refund'` transactions still `pending` at the gateway (e.g. PayPal settling). */
      pendingCents: number;
      /**
       * The CEILING for any new refund on this order right now:
       * max(0, sale - refunded - pending). Pending refunds are subtracted so
       * an in-flight refund is never counted as headroom (see
       * `findPendingRefundTxn` in `shopify-order-actions.ts`).
       */
      refundableCents: number;
      /**
       * Sum of settled Shopify refunds that are NOT present in our local
       * `public.order_refunds` mirror. `> 0` means someone refunded outside
       * ShopCX (a manual refund in the Shopify admin) — the exact signal
       * that was missing on SC133086.
       */
      outOfBandCents: number;
      refunds: RefundLedgerLine[];
    }
  | {
      ok: false;
      reason:
        | "order_not_found"
        | "no_shopify_order_id"
        | "shopify_call_failed"
        | "invalid_input";
      error?: string;
    };

interface MirrorRow {
  amount_cents: number;
}

/**
 * Pure ledger computation — separated from the Shopify + Supabase I/O so it
 * can be unit-tested without hitting the network.
 *
 * Reconciliation is a greedy amount-match: each Shopify refund is matched
 * against at most one still-unconsumed mirror row of the same `amount_cents`.
 * A refund with no matching mirror row is out-of-band (someone refunded
 * outside ShopCX).
 */
export function computeRefundLedger(
  transactions: ShopifyTxnLite[] | null | undefined,
  mirror: MirrorRow[] | null | undefined,
): {
  saleCents: number;
  refundedCents: number;
  pendingCents: number;
  refundableCents: number;
  outOfBandCents: number;
  refunds: RefundLedgerLine[];
} {
  const txns = Array.isArray(transactions) ? transactions : [];
  const unconsumedMirror = (mirror ?? []).map((r) => r.amount_cents);

  let saleCents = 0;
  let refundedCents = 0;
  let pendingCents = 0;
  let outOfBandCents = 0;
  const refunds: RefundLedgerLine[] = [];

  for (const t of txns) {
    const rawStatus = String(t?.status ?? "").toLowerCase();
    const kind = String(t?.kind ?? "").toLowerCase();
    const amountCents = amountToCents((t as { amount?: string | number | null }).amount);
    const processedAt =
      (t as { processed_at?: string | null; created_at?: string | null }).processed_at ??
      (t as { created_at?: string | null }).created_at ??
      null;
    const gateway = (t as { gateway?: string | null }).gateway ?? null;
    const status: RefundLedgerLine["status"] =
      rawStatus === "success"
        ? "success"
        : rawStatus === "pending"
          ? "pending"
          : rawStatus === "failure"
            ? "failure"
            : rawStatus === "error"
              ? "error"
              : "other";

    if ((kind === "sale" || kind === "capture") && status === "success") {
      saleCents += amountCents;
      continue;
    }

    if (kind !== "refund") continue;
    if (status !== "success" && status !== "pending") continue;

    if (status === "success") {
      refundedCents += amountCents;
    } else {
      pendingCents += amountCents;
    }

    let mirroredLocally = false;
    if (status === "success") {
      const idx = unconsumedMirror.indexOf(amountCents);
      if (idx >= 0) {
        mirroredLocally = true;
        unconsumedMirror.splice(idx, 1);
      } else {
        outOfBandCents += amountCents;
      }
    }

    refunds.push({
      amountCents,
      gateway,
      processedAt,
      status,
      mirroredLocally,
    });
  }

  const refundableCents = Math.max(0, saleCents - refundedCents - pendingCents);

  return {
    saleCents,
    refundedCents,
    pendingCents,
    refundableCents,
    outOfBandCents,
    refunds,
  };
}

/**
 * Pure branch decider for the Phase-1 self-healing return-refund rail.
 *
 * Given the live ledger + the return's stored `net_refund_cents` contract,
 * returns which branch `returnsIssueRefund` should take BEFORE dispatching
 * a refund. Extracted from src/lib/inngest/returns.ts so the branching
 * logic is unit-testable without spinning up Inngest / Supabase / Shopify.
 *
 * - `stamp_out_of_band` — the money already moved outside ShopCX
 *   (refundable is 0 AND enough has been refunded to cover the contract).
 *   Caller stamps the return with `refund_id='out_of_band_shopify'`
 *   and issues NO refund. (SC130193.)
 * - `cap_to_ledger` — the gateway still has room, but less than the
 *   contract. Caller refunds `refundCents` (the ceiling) and records
 *   `shortfallCents` on the return row for audit. (SC133086 / SC129432.)
 * - `refund_full_contract` — refundable meets or exceeds the contract,
 *   OR the ledger was unreadable (Phase 1 does not add new failure
 *   modes — an unknown ledger falls through to today's behaviour;
 *   Phase 2 will make failures loud). Caller refunds `refundCents`
 *   (== netRefundCents) unchanged.
 *
 * Contract vs ceiling: `netRefundCents` is the INTENT (set at return
 * creation, never raised). This decider only ever LOWERS what the
 * rail dispatches — the return-creation stored contract stays the
 * source of intent.
 */
export type RefundReconcileDecision =
  | { branch: "stamp_out_of_band"; refundedCents: number }
  | { branch: "cap_to_ledger"; refundCents: number; shortfallCents: number }
  | { branch: "refund_full_contract"; refundCents: number };

export function decideRefundReconcile(
  ledger: OrderRefundLedger,
  netRefundCents: number,
): RefundReconcileDecision {
  if (ledger.ok) {
    if (ledger.refundableCents === 0 && ledger.refundedCents >= netRefundCents) {
      return { branch: "stamp_out_of_band", refundedCents: ledger.refundedCents };
    }
    if (ledger.refundableCents > 0 && ledger.refundableCents < netRefundCents) {
      return {
        branch: "cap_to_ledger",
        refundCents: ledger.refundableCents,
        shortfallCents: netRefundCents - ledger.refundableCents,
      };
    }
  }
  return { branch: "refund_full_contract", refundCents: netRefundCents };
}

function amountToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const n = typeof amount === "number" ? amount : parseFloat(String(amount));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Live refundable-balance read for a Shopify order.
 *
 * @param workspaceId - workspace scoping every DB + credential lookup.
 * @param orderId     - INTERNAL `orders.id` UUID (never the human-facing
 *                      `shopify_order_id` / `order_number`; CLAUDE.md hard
 *                      rule: internal joins use UUIDs).
 *
 * Returns a discriminated `OrderRefundLedger` union — never throws. A missing
 * order, a non-Shopify order, or a failed Shopify call all resolve to an
 * `{ ok: false, reason }` shape so the caller can render an explicit "unknown
 * ledger" instead of an exception.
 */
export async function getOrderRefundLedger(
  workspaceId: string,
  orderId: string,
): Promise<OrderRefundLedger> {
  if (!workspaceId || !orderId) {
    return { ok: false, reason: "invalid_input", error: "workspaceId and orderId are required" };
  }

  const admin = createAdminClient();

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, shopify_order_id")
    .eq("id", orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (orderErr) {
    return { ok: false, reason: "order_not_found", error: orderErr.message };
  }
  if (!order) {
    return { ok: false, reason: "order_not_found" };
  }
  if (!order.shopify_order_id) {
    return { ok: false, reason: "no_shopify_order_id" };
  }

  let transactions: ShopifyTxnLite[] = [];
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${order.shopify_order_id}/transactions.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        reason: "shopify_call_failed",
        error: `Shopify transactions.json ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { transactions?: ShopifyTxnLite[] };
    transactions = Array.isArray(data?.transactions) ? data.transactions : [];
  } catch (e) {
    return {
      ok: false,
      reason: "shopify_call_failed",
      error: errText(e),
    };
  }

  const { data: mirrorRows } = await admin
    .from("order_refunds")
    .select("amount_cents")
    .eq("workspace_id", workspaceId)
    .eq("order_id", order.id)
    .in("status", ["succeeded", "settled"]);

  const ledger = computeRefundLedger(transactions, mirrorRows ?? []);

  // Sanity: if the pure detector sees a pending refund but our loop didn't,
  // that's a shape drift we want to know about — surface it in the ledger's
  // pendingCents by adding it defensively. (No-op in the common case.)
  if (ledger.pendingCents === 0) {
    const pending = findPendingRefundTxn(transactions);
    if (pending) {
      const pc = amountToCents(pending.amount);
      if (pc > 0) {
        ledger.pendingCents = pc;
        ledger.refundableCents = Math.max(0, ledger.refundableCents - pc);
      }
    }
  }

  return {
    ok: true,
    saleCents: ledger.saleCents,
    refundedCents: ledger.refundedCents,
    pendingCents: ledger.pendingCents,
    refundableCents: ledger.refundableCents,
    outOfBandCents: ledger.outOfBandCents,
    refunds: ledger.refunds,
  };
}
