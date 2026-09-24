// vendor-refund-mirror — write an `order_refunds` row for a refund the
// vendor already fired, regardless of who initiated it.
//
// `refundOrder` (src/lib/refund.ts) is the only path that writes to
// `order_refunds` today, so a refund issued by hand in the Shopify admin
// (or by any path that does not call `refundOrder`) leaves the ledger
// empty. The double-refund guard and the overcharge sizer both read that
// ledger, so a missing row means the guard is blind and a future
// automated path could refund the same money twice.
//
// The Shopify `refunds/create` webhook is the primary source. Reconciling
// against the order's `financial_status` (via the REST refunds list) is
// the fallback for anything the webhook missed (unregistered, dropped,
// pre-shipping historical). Either way this module produces the SAME
// row shape `refundOrder` writes — `vendor`, `amount_cents`, `status`,
// `vendor_refund_id`, and a stable `request_key` — so the unique index
// on `(order_id, request_key)` keeps a re-delivered webhook from writing
// a duplicate, and an existing `vendor_refund_id` match keeps a webhook
// echo of a refund WE fired from writing a second row.
//
// Money never moves here. This module only records what already happened.

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { deriveAndSetOrderRefundStatus } from "@/lib/refund";

export interface ParsedShopifyRefund {
  shopifyRefundId: string;
  shopifyOrderId: string;
  amountCents: number;
  hasSuccessfulTransaction: boolean;
}

interface ShopifyRefundTxnLite {
  kind?: string;
  status?: string;
  amount?: string | number;
}

interface ShopifyRefundPayloadLite {
  id?: string | number;
  order_id?: string | number;
  transactions?: ShopifyRefundTxnLite[];
}

// Sum the refund-side transactions on a Shopify refund payload. A refund
// can carry multiple transactions (partial-refund composition, split
// gateways); we only count `kind='refund'` rows with a non-failure
// status. `pending` counts — the vendor already accepted the refund even
// if the gateway is still settling.
export function parseShopifyRefundPayload(
  payload: ShopifyRefundPayloadLite | null | undefined,
): ParsedShopifyRefund | null {
  if (!payload) return null;
  const shopifyRefundId = payload.id != null ? String(payload.id) : "";
  const shopifyOrderId = payload.order_id != null ? String(payload.order_id) : "";
  if (!shopifyRefundId || !shopifyOrderId) return null;

  const txns = Array.isArray(payload.transactions) ? payload.transactions : [];
  let amountCents = 0;
  let hasSuccessfulTransaction = false;
  for (const t of txns) {
    if (String(t?.kind ?? "").toLowerCase() !== "refund") continue;
    const status = String(t?.status ?? "").toLowerCase();
    if (status === "failure" || status === "error") continue;
    const raw = t?.amount;
    const asNumber = typeof raw === "number" ? raw : parseFloat(String(raw ?? "0"));
    if (!Number.isFinite(asNumber) || asNumber <= 0) continue;
    amountCents += Math.round(asNumber * 100);
    if (status === "success" || status === "settled") hasSuccessfulTransaction = true;
  }
  return {
    shopifyRefundId,
    shopifyOrderId,
    amountCents,
    hasSuccessfulTransaction,
  };
}

// Stable request_key for a backfill-from-financial-status insert.
// Keyed on the internal order id (one gap-fill row per order at most),
// so re-running the backfill collides on the unique index and is a
// no-op — that's the SC137733 idempotency proof the spec cites.
export function backfillFromFinancialStatusRequestKey(orderId: string): string {
  return `backfill:financial_status:${orderId}`;
}

export interface BackfillGapInputs {
  financialStatus: string | null;
  totalCents: number | null;
  mirroredSuccessSettledCents: number | null;
}

export type BackfillGapDecision =
  | { skip: false; gapCents: number }
  | { skip: true; reason: "not_fully_refunded" | "no_total" | "already_covered" | "over_total" };

/**
 * Per-order backfill decision. Pure — no I/O. The spec's exact rule:
 *   - Only `financial_status = 'refunded'` (case-insensitive) qualifies;
 *     `partially_refunded` is skipped (no unambiguous expected value).
 *   - `gap = total_cents - sum(succeeded/settled order_refunds)`; skip
 *     when the ledger already covers the total.
 *   - Refuse to write a row that would exceed `total_cents` (defensive
 *     — impossible under `gap = total - sum` arithmetic, but the check
 *     is explicit per the spec: "the backfill must refuse to write a
 *     row that would exceed total_cents").
 */
export function decideFinancialStatusBackfill(
  input: BackfillGapInputs,
): BackfillGapDecision {
  const status = String(input.financialStatus ?? "").toLowerCase();
  if (status !== "refunded") return { skip: true, reason: "not_fully_refunded" };
  const total = Number(input.totalCents ?? 0);
  if (!Number.isFinite(total) || total <= 0) return { skip: true, reason: "no_total" };
  const existing = Math.max(0, Number(input.mirroredSuccessSettledCents ?? 0) | 0);
  const gap = total - existing;
  if (gap <= 0) return { skip: true, reason: "already_covered" };
  if (existing + gap > total) return { skip: true, reason: "over_total" };
  return { skip: false, gapCents: gap };
}

// Stable, vendor-scoped request_key for a Shopify refund. Using the
// refund id (unique per refund at Shopify) keeps a re-delivered webhook
// idempotent via the (order_id, request_key) unique index. Distinct from
// `hashRefundRequestKey` (which keys on shape) on purpose — a webhook
// carrying the vendor's own refund id gets to key on that id directly.
export function shopifyRefundRequestKey(shopifyRefundId: string): string {
  return `shopify_refund:${shopifyRefundId}`;
}

export type MirrorInsertResult =
  | { inserted: true; order_id: string; amount_cents: number; vendor_refund_id: string }
  | { inserted: false; reason: "order_not_found" | "amount_zero" | "already_mirrored" | "insert_failed"; detail?: string };

/**
 * Insert an `order_refunds` mirror row for a Shopify refund the vendor
 * already completed. Idempotent on TWO axes:
 *   1. (order_id, request_key) — the DB unique index catches a re-delivered
 *      webhook (same shopify refund id ⇒ same request_key).
 *   2. (workspace_id, order_id, vendor='shopify', vendor_refund_id) — a
 *      pre-insert lookup catches a refund we already mirrored via
 *      `refundOrder` (which writes vendor_refund_id from the same source).
 *      Without this, refundOrder's row and the webhook's row would carry
 *      different request_keys and both land.
 *
 * NEVER moves money. If the refund did not actually complete at the
 * vendor (no succeeded/settled transaction on the payload), the caller
 * should skip — we only record refunds the vendor has finished.
 */
export async function insertShopifyRefundMirror(
  workspaceId: string,
  parsed: ParsedShopifyRefund,
): Promise<MirrorInsertResult> {
  if (parsed.amountCents <= 0) {
    return { inserted: false, reason: "amount_zero" };
  }
  const admin = createAdminClient();
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_order_id", parsed.shopifyOrderId)
    .maybeSingle();
  if (orderErr) {
    return { inserted: false, reason: "insert_failed", detail: `Order lookup failed: ${orderErr.message}` };
  }
  if (!order) {
    return { inserted: false, reason: "order_not_found", detail: `No order with shopify_order_id=${parsed.shopifyOrderId}` };
  }

  // Semantic dedupe against refundOrder-initiated refunds. refundOrder
  // stores the vendor's refund id in `vendor_refund_id`, so a match on
  // that exact identity means the money we saw here already has a
  // mirror row. Skip rather than fabricate a duplicate.
  const { data: existingByVendorId } = await admin
    .from("order_refunds")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("order_id", order.id)
    .eq("vendor", "shopify")
    .eq("vendor_refund_id", parsed.shopifyRefundId)
    .maybeSingle();
  if (existingByVendorId) {
    return { inserted: false, reason: "already_mirrored" };
  }

  const requestKey = shopifyRefundRequestKey(parsed.shopifyRefundId);
  try {
    const { error: insertErr } = await admin.from("order_refunds").insert({
      workspace_id: workspaceId,
      order_id: order.id,
      request_key: requestKey,
      vendor: "shopify",
      vendor_refund_id: parsed.shopifyRefundId,
      amount_cents: parsed.amountCents,
      status: "succeeded",
      source: "live",
    });
    if (insertErr) {
      // A duplicate (order_id, request_key) — a webhook re-delivery
      // that raced the vendor_refund_id lookup, or the same refund id
      // arriving twice — lands here. Not an error: the ledger already
      // has the row, which is exactly what we wanted.
      const code = (insertErr as { code?: string }).code;
      if (code === "23505") {
        return { inserted: false, reason: "already_mirrored" };
      }
      return { inserted: false, reason: "insert_failed", detail: insertErr.message };
    }
  } catch (e) {
    return { inserted: false, reason: "insert_failed", detail: errText(e) };
  }
  return {
    inserted: true,
    order_id: order.id,
    amount_cents: parsed.amountCents,
    vendor_refund_id: parsed.shopifyRefundId,
  };
}

/**
 * Fallback reconciler: fetch every refund on a Shopify order via REST
 * and mirror any that aren't in our ledger yet. Called when a
 * `financial_status` transition to refunded/partially_refunded reaches
 * us via `orders/updated` and the primary `refunds/create` webhook
 * either didn't fire or already fired but was missed at the time.
 *
 * READ-ONLY at the vendor — this just lists refunds that already
 * completed. No money moves.
 */
export async function reconcileShopifyRefundsForOrder(
  workspaceId: string,
  shopifyOrderId: string,
): Promise<{ ok: true; mirrored: number; skipped: number } | { ok: false; reason: string }> {
  if (!workspaceId || !shopifyOrderId) {
    return { ok: false, reason: "workspaceId + shopifyOrderId required" };
  }
  let shop: string;
  let accessToken: string;
  try {
    ({ shop, accessToken } = await getShopifyCredentials(workspaceId));
  } catch (e) {
    return { ok: false, reason: `Shopify credentials unavailable: ${errText(e)}` };
  }
  let payload: { refunds?: ShopifyRefundPayloadLite[] };
  try {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}/refunds.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    if (!res.ok) {
      return { ok: false, reason: `Shopify refunds list HTTP ${res.status}` };
    }
    payload = (await res.json()) as { refunds?: ShopifyRefundPayloadLite[] };
  } catch (e) {
    return { ok: false, reason: `Shopify refunds list error: ${errText(e)}` };
  }
  let mirrored = 0;
  let skipped = 0;
  for (const raw of payload.refunds ?? []) {
    const parsed = parseShopifyRefundPayload({ ...raw, order_id: raw.order_id ?? shopifyOrderId });
    if (!parsed) {
      skipped++;
      continue;
    }
    if (!parsed.hasSuccessfulTransaction) {
      // Ledger-only for refunds the vendor actually completed. A
      // pending-only refund gets picked up when it lands as a
      // refunds/create with a succeeded transaction.
      skipped++;
      continue;
    }
    const result = await insertShopifyRefundMirror(workspaceId, parsed);
    if (result.inserted) mirrored++;
    else skipped++;
  }
  return { ok: true, mirrored, skipped };
}

// ── Braintree counterpart ────────────────────────────────────────────
// A refund performed on the card gateway (Braintree) produces no ledger
// row and no status change on our side — the shipped Shopify mirror is
// blind to the gateway path. Four orders totalling $532.90 measured on
// 2026-09-24 are gateway-refunded with no ledger row, and the near-miss
// on 2026-09-24 (SHOPCX373, refund pr0jwp0z) is the whole reason this
// mirror exists: the customer was refunded $140.28 at the gateway six
// days before a founder-queue session tried to refund her a second time
// and only the gateway itself refused. This module ingests that path.
//
// Money never moves here. This module only records what already happened
// at Braintree — either via a webhook (the primary source) or via a
// reconcile that reads the transaction's refunds off the gateway.
//
// Row shape is identical to the Shopify mirror (same `vendor_refund_id`,
// same `request_key` uniqueness discipline, same `source='live'` on the
// happy path and `'backfill'` on the historical arm), so downstream
// consumers (double-refund guard, financial_status derivation, audit)
// see one uniform ledger.

// Stable, vendor-scoped request_key for a Braintree refund. The refund
// id at Braintree (e.g. `pr0jwp0z`) is unique per refund transaction,
// so keying on it means a re-delivered webhook or a re-run reconcile
// hits the `(order_id, request_key)` unique index rather than writing
// a second row.
export function braintreeRefundRequestKey(refundId: string): string {
  return `braintree_refund:${refundId}`;
}

export interface ParsedBraintreeRefund {
  braintreeRefundId: string;
  braintreeTransactionId: string;
  amountCents: number;
}

/**
 * Insert an `order_refunds` mirror row for a Braintree refund the
 * gateway already completed. Idempotent on TWO axes — same discipline
 * as `insertShopifyRefundMirror`:
 *   1. (order_id, request_key) — the DB unique index catches a re-run
 *      or a re-delivered webhook (same braintree refund id ⇒ same
 *      request_key).
 *   2. (workspace_id, order_id, vendor='braintree', vendor_refund_id) —
 *      a pre-insert lookup catches a refund we already mirrored via
 *      `refundOrder` (which writes vendor_refund_id from the same
 *      Braintree result). Without this, refundOrder's row and the
 *      webhook's row would carry different request_keys and both land.
 *
 * `source` defaults to `'live'` (the ongoing capture path). The
 * reconcile arm below passes `'backfill'` for a historical row.
 *
 * NEVER moves money.
 */
export async function insertBraintreeRefundMirror(
  workspaceId: string,
  orderId: string,
  parsed: ParsedBraintreeRefund,
  opts?: { source?: "live" | "backfill" },
): Promise<MirrorInsertResult> {
  if (parsed.amountCents <= 0) {
    return { inserted: false, reason: "amount_zero" };
  }
  const admin = createAdminClient();

  // Confirm the order exists inside the tenant. `insertShopifyRefundMirror`
  // resolves the order from the shopify_order_id; here the caller
  // already knows the internal order_id, so we just double-check it
  // exists inside the workspace (a stray refund id from another tenant
  // can never fabricate a row).
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) {
    return { inserted: false, reason: "insert_failed", detail: `Order lookup failed: ${orderErr.message}` };
  }
  if (!order) {
    return { inserted: false, reason: "order_not_found", detail: `No order with id=${orderId} in workspace` };
  }

  // Semantic dedupe against refundOrder-initiated refunds. refundOrder
  // stores the gateway refund id in `vendor_refund_id`, so a match on
  // that exact identity means the money we saw here already has a
  // mirror row.
  const { data: existingByVendorId } = await admin
    .from("order_refunds")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("order_id", order.id)
    .eq("vendor", "braintree")
    .eq("vendor_refund_id", parsed.braintreeRefundId)
    .maybeSingle();
  if (existingByVendorId) {
    return { inserted: false, reason: "already_mirrored" };
  }

  const requestKey = braintreeRefundRequestKey(parsed.braintreeRefundId);
  try {
    const { error: insertErr } = await admin.from("order_refunds").insert({
      workspace_id: workspaceId,
      order_id: order.id,
      request_key: requestKey,
      vendor: "braintree",
      vendor_refund_id: parsed.braintreeRefundId,
      amount_cents: parsed.amountCents,
      status: "succeeded",
      source: opts?.source ?? "live",
    });
    if (insertErr) {
      const code = (insertErr as { code?: string }).code;
      if (code === "23505") {
        return { inserted: false, reason: "already_mirrored" };
      }
      return { inserted: false, reason: "insert_failed", detail: insertErr.message };
    }
  } catch (e) {
    return { inserted: false, reason: "insert_failed", detail: errText(e) };
  }
  return {
    inserted: true,
    order_id: order.id,
    amount_cents: parsed.amountCents,
    vendor_refund_id: parsed.braintreeRefundId,
  };
}

// A Braintree Transaction carries its refunds as either an inline array
// of Transaction objects (each a type='credit' transaction) or as a
// `refundIds` list. We only need the id + amount to build the mirror
// row; we do NOT re-verify that the refund settled — the transaction's
// existence in the .refunds list IS the gateway's confirmation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBraintreeRefunds(txn: any): ParsedBraintreeRefund[] {
  const list: ParsedBraintreeRefund[] = [];
  const braintreeTransactionId = String(txn?.id ?? "");
  const inline = Array.isArray(txn?.refunds) ? txn.refunds : [];
  for (const r of inline) {
    const id = r?.id != null ? String(r.id) : "";
    if (!id) continue;
    const raw = r?.amount;
    const asNumber = typeof raw === "number" ? raw : parseFloat(String(raw ?? "0"));
    if (!Number.isFinite(asNumber) || asNumber <= 0) continue;
    list.push({
      braintreeRefundId: id,
      braintreeTransactionId,
      amountCents: Math.round(asNumber * 100),
    });
  }
  return list;
}

/**
 * Reconcile Braintree refunds for a single order. Reads the order's
 * `braintree_transaction_id`, asks the gateway what refunds sit against
 * that transaction, and mirrors any missing ones through
 * `insertBraintreeRefundMirror`. After the mirror pass finishes, delegates
 * to Phase 1's `deriveAndSetOrderRefundStatus` so the order's payment
 * state advances with the ledger — one call, one writer.
 *
 * READ-ONLY at the gateway. No money moves. Idempotent: a re-run over
 * an already-mirrored refund hits the (vendor, vendor_refund_id) dedupe
 * and is a no-op, and the derive routine's own weight guard keeps a
 * second pass from churning the order status.
 */
export async function reconcileBraintreeRefundsForOrder(
  workspaceId: string,
  orderId: string,
  opts?: { source?: "live" | "backfill" },
): Promise<
  | { ok: true; mirrored: number; skipped: number; status?: "refunded" | "partially_refunded" | null }
  | { ok: false; reason: string }
> {
  if (!workspaceId || !orderId) {
    return { ok: false, reason: "workspaceId + orderId required" };
  }
  const admin = createAdminClient();
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, braintree_transaction_id")
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) return { ok: false, reason: `Order lookup failed: ${orderErr.message}` };
  if (!order) return { ok: false, reason: `Order ${orderId} not found in workspace` };
  const braintreeTxnId = (order.braintree_transaction_id ?? null) as string | null;
  if (!braintreeTxnId) {
    return { ok: false, reason: "Order has no braintree_transaction_id — nothing to reconcile" };
  }

  let refunds: ParsedBraintreeRefund[];
  try {
    const gateway = await getBraintreeGateway(workspaceId);
    const txn = await gateway.transaction.find(braintreeTxnId).catch(() => null);
    if (!txn) return { ok: false, reason: `Braintree transaction ${braintreeTxnId} not found` };
    refunds = extractBraintreeRefunds(txn);
  } catch (e) {
    return { ok: false, reason: `Braintree gateway error: ${errText(e)}` };
  }

  let mirrored = 0;
  let skipped = 0;
  for (const parsed of refunds) {
    const result = await insertBraintreeRefundMirror(workspaceId, order.id, parsed, {
      source: opts?.source ?? "live",
    });
    if (result.inserted) mirrored++;
    else skipped++;
  }

  // Advance orders.financial_status through the ONE writer so the
  // ledger and the column agree byte-for-byte with the derive rules
  // used by refundOrder (Phase 1).
  const derived = await deriveAndSetOrderRefundStatus(workspaceId, order.id);
  const status = derived.ok ? (derived.to ?? null) : null;
  return { ok: true, mirrored, skipped, status };
}
