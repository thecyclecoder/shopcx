// Shopify Returns API — create returns, attach tracking, dispose items, process, close

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { errText } from "@/lib/error-text";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrderRefundLedger } from "@/lib/refund-ledger";

// ── GraphQL helper ──

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  return res.json();
}

// ── Pure return-refund-ceiling helper (Phase 2 of a-money-remedy-must-read-the-live-remedy-state-first) ──

/**
 * Terminal statuses on `public.order_refunds` mirror rows that MOVED (or authoritatively will move)
 * money. Same set the CX SDK's `getOrderRemedyState` sums for the remaining-refundable-value
 * computation — kept in one place so the return-creation and refund-time paths agree with the
 * money-remedy hard-reject on which refunds count against the ceiling.
 */
export const RETURN_REFUND_LEDGER_TERMINAL_STATUSES = new Set(["succeeded", "settled"]);

/**
 * Compute a return row's `net_refund_cents` — the CONTRACT the downstream refund pipeline
 * ([[../inngest/returns]] `returnsIssueRefund`) reads to know how much to refund on delivery.
 *
 * Phase 2 of [[../../docs/brain/specs/a-money-remedy-must-read-the-live-remedy-state-first]]:
 * BEFORE this helper existed, the return creator computed order-total minus label and IGNORED any
 * refund the customer had already received on the same order. Derived-from ticket `86043da0` (Jan
 * Bloom): a $182.95 order had a $15 refund fired 36 minutes before the return was created, and the
 * return stored `net_refund_cents = 18295` — the pipeline was one delivery away from over-refunding
 * by $15 silently (corrected by a human before it fired). The fix nets the ledger's succeeded
 * refunds into the ceiling: **`subtotal - Σ succeeded refunds - label`**, floored at 0. A `label`
 * cost of 0 (crisis-return / `freeLabel: true`) leaves the label term unchanged; the caller
 * decides that policy and passes the resulting `labelCostCents`.
 *
 * Phase 3 of [[../../docs/brain/specs/remedy-state-must-see-out-of-band-refunds]]: the input is the
 * order's SUBTOTAL (line items excluding Shipping Protection), not `total_cents`. The `returns`
 * policy `returns.refund_formula` machine rule (see [[../tables/policies]] two-halves rule) reads
 * `order_subtotal - label_cost` and explicitly excludes Shipping Protection, customer-paid shipping
 * and the label cost — computing from the full total (which folds tax + shipping in) over-promises
 * by exactly that amount. On yvette SC126000 (2026-08-24) it inflated the promise from $50.54 to
 * $55.86; we told a customer a number our own policy does not sanction. The input field is
 * `orderSubtotalCents` (renamed from the historical total-based name) so a caller cannot pass the
 * wrong figure by habit.
 *
 * Pure — the test suite pins the Jan Bloom shape explicitly. Inputs are pre-summed cents; the
 * async ledger fetch + the subtotal derivation both live at the caller (creator + refund-time
 * re-check) so this stays deterministic and cheap to test.
 */
export function computeReturnNetRefundCents(input: {
  orderSubtotalCents: number;
  labelCostCents: number;
  refundsSucceededCents: number;
}): number {
  const subtotal = Number.isFinite(input.orderSubtotalCents) ? Math.max(0, Math.round(input.orderSubtotalCents)) : 0;
  const label = Number.isFinite(input.labelCostCents) ? Math.max(0, Math.round(input.labelCostCents)) : 0;
  const refunded = Number.isFinite(input.refundsSucceededCents) ? Math.max(0, Math.round(input.refundsSucceededCents)) : 0;
  return Math.max(0, subtotal - refunded - label);
}

/**
 * Derive an order's REFUNDABLE SUBTOTAL from its `line_items` — the sum of
 * `price_cents * quantity - total_discount_cents` EXCLUDING any Shipping Protection line. Pinned in
 * one exported helper so every downstream refund path (return-creation + any future refund path)
 * agrees on which lines count.
 *
 * Phase 3 of [[../../docs/brain/specs/remedy-state-must-see-out-of-band-refunds]] — the `returns`
 * policy row (see [[../tables/policies]]) reads: "Refund math: net_refund = order_subtotal -
 * label_cost" and "Excluded from refund: Shipping Protection, customer-paid shipping costs, return
 * label costs". `public.orders` has NO subtotal column (probed 2026-08-24 — the columns are
 * total_cents, line_items, shipping_protection_amount_cents, avalara_total_tax_cents), so we sum
 * the line items ourselves and match Shopify's Shipping Protection line by title. The same
 * title match is what [[../libraries/avalara-tax-codes]] `classifyByShopifyCategory` uses to bucket
 * a line as `shipping_protection` on the tax side, so a policy change to the SP title propagates in
 * one place, not several. Pure + deterministic — no async, no dependencies beyond a lines array.
 *
 * Phase 1 of [[../../docs/brain/specs/return-net-refund-must-net-per-line-discounts]] — Shopify
 * stores each line's discount in `total_discount_cents` (the sum across the line's units, mirrored
 * from webhook payload `total_discount`, see [[shopify-webhooks]] `line_items` map). BEFORE this
 * fix the derivation summed gross `price_cents * quantity` and IGNORED that field, so any
 * discounted order over-promised the refundable ceiling by exactly the discount amount. Live case
 * from ticket `d17c7b1c` / SC137380: coffee line $79.95 × 2 GROSS = $159.90 with a $12.78 line
 * discount (customer paid $147.12), order collected $155.95 — the gross figure tripped
 * `assertReturnRefundHeadroom` ("$159.90 exceeds live refundable ceiling $155.95") and REFUSED a
 * legitimate in-policy Tier-2 return. Netting per-line makes the subtotal match what the customer
 * actually paid, so the headroom check sees $147.12 (below the $155.95 ceiling) and clears.
 * `total_discount_cents` floors at 0 and clamps to `qty * price` — a bad row cannot push the line's
 * contribution negative.
 */
export function deriveOrderSubtotalCentsFromLines(
  lines: OrderLineItemLite[] | null | undefined,
): number {
  const arr = Array.isArray(lines) ? lines : [];
  let subtotal = 0;
  for (const l of arr) {
    const title = String(l?.title ?? "");
    if (/shipping\s*protection|upcart|shopwill/i.test(title)) continue;
    const qty = Number.isFinite(l?.quantity) ? Math.max(0, Math.round(l!.quantity!)) : 0;
    const price = Number.isFinite(l?.price_cents) ? Math.max(0, Math.round(l!.price_cents!)) : 0;
    const gross = qty * price;
    const discount = Number.isFinite(l?.total_discount_cents)
      ? Math.max(0, Math.round(l!.total_discount_cents!))
      : 0;
    subtotal += Math.max(0, gross - discount);
  }
  return subtotal;
}

/**
 * Pure derivation of the refund ceiling for an INTERNAL (non-Shopify) order — the order's own
 * total minus the terminal refunds already recorded against it, floored at 0. Kept as an exported
 * pure helper so the arithmetic is unit-testable and lives in one place; the only caller today is
 * `readReturnCreationRefundLedger`'s no_shopify_order_id branch, which passes the DB-read
 * `orders.total_cents` and the mirror sum over `RETURN_REFUND_LEDGER_TERMINAL_STATUSES`.
 *
 * Phase 1 of [[../../docs/brain/specs/internal-order-returns-blocked-by-refund-headroom-guard]] —
 * `getOrderRefundLedger` cannot answer for an order that never existed in Shopify, and treating
 * that as "unverifiable" refused 100% of internal-order returns (SHOPCX*). The ceiling IS knowable
 * without Shopify: subtotal doesn't apply here because internal orders have no separate Shipping
 * Protection line to strip — the total IS the customer-paid figure — so we net the mirror's
 * terminal refunds directly against `orders.total_cents`.
 */
export function deriveInternalRefundCeilingCents(input: {
  orderTotalCents: number;
  refundedCents: number;
}): number {
  const total = Number.isFinite(input.orderTotalCents) ? Math.max(0, Math.round(input.orderTotalCents)) : 0;
  const refunded = Number.isFinite(input.refundedCents) ? Math.max(0, Math.round(input.refundedCents)) : 0;
  return Math.max(0, total - refunded);
}

/**
 * Discriminated verdict for the creation-time refund-headroom check — the shape the extracted
 * `assertReturnRefundHeadroom` returns. `ok:true` means the return is safe to create for the
 * promised `net_refund_cents`; `ok:false` carries the caller-facing `error` string with the two
 * numbers named. Split into its own type so the callsite reads as a single named check rather than
 * an inline `if / return { success:false, error }` block that can drift out of place.
 */
export type ReturnRefundHeadroomVerdict =
  | { ok: true }
  | { ok: false; reason: "unreadable_ledger" | "exceeds_ceiling"; error: string };

/**
 * Pure headroom check for return creation — a return that promises MORE than the order can
 * actually pay is worse than no return (the customer ships product back and then chases us).
 * Extracted from the inline `if (netRefundCents > 0) { ... }` block in `createFullReturn` so the
 * check's POSITION is expressed as one named call — the extraction is the anti-drift.
 *
 * Refuses when:
 *  - the live ledger is unreadable (refundableCents == null) — a refund guard that cannot verify
 *    headroom must refuse, never assume. Internal (SHOPCX*) orders bypass this via
 *    `readReturnCreationRefundLedger`'s `no_shopify_order_id` branch (a local ceiling is
 *    computed), so this branch fires only for a genuine Shopify outage.
 *  - `netRefundCents > refundableCents` — the promised net exceeds the live ceiling; both numbers
 *    are named in the error string.
 *
 * `netRefundCents <= 0` is a no-op (there is nothing to promise) and always passes.
 */
export function assertReturnRefundHeadroom(input: {
  netRefundCents: number;
  refundableCents: number | null;
  orderNumber: string;
}): ReturnRefundHeadroomVerdict {
  const net = Number.isFinite(input.netRefundCents) ? Math.max(0, Math.round(input.netRefundCents)) : 0;
  if (net <= 0) return { ok: true };
  if (input.refundableCents == null) {
    return {
      ok: false,
      reason: "unreadable_ledger",
      error: `Refusing to create return: live refund ledger is unreadable so headroom cannot be verified. Promised net_refund $${(net / 100).toFixed(2)} against unknown live refundable ceiling — a refund guard that cannot verify headroom must refuse, never assume.`,
    };
  }
  if (net > input.refundableCents) {
    return {
      ok: false,
      reason: "exceeds_ceiling",
      error: `Refusing to create return: net_refund $${(net / 100).toFixed(2)} exceeds live refundable ceiling $${(input.refundableCents / 100).toFixed(2)} on order ${input.orderNumber} (Shopify ledger — includes out-of-band refunds). A return that promises more than the order can pay strands the customer.`,
    };
  }
  return { ok: true };
}

/**
 * Live refund headroom for the return-creation + refund-time paths — routes through
 * [[refund-ledger]] `getOrderRefundLedger` so out-of-band Shopify refunds count against the ceiling
 * (Phase 2 of [[../../docs/brain/specs/remedy-state-must-see-out-of-band-refunds]]). Returns both
 * numbers the return-creation path needs in ONE Shopify call:
 *   `refundedCents`   — the ledger's total refunded (mirrored + out-of-band). This replaces
 *                       `sumSucceededOrderRefundsCents`'s mirror-only sum as the input to
 *                       `computeReturnNetRefundCents`.
 *   `refundableCents` — the ledger's `max(0, sale - refunded - pending)` — the HARD CEILING for
 *                       any new refund. `null` when the Shopify ledger itself is unreadable
 *                       (Shopify down, order_not_found, invalid_input); a caller must NOT invent a
 *                       ceiling from a missing signal. INTERNAL (non-Shopify) orders are the one
 *                       exception — see the `no_shopify_order_id` branch below.
 *   `ok`              — false when the ledger call itself failed; the mirror-only fallback for
 *                       `refundedCents` is populated but the creation-time refusal cannot fire.
 *
 * The mirror-only fallback (workspace-scoped sum over `public.order_refunds` where
 * `status IN ('succeeded','settled')`) is retained so a transient Shopify blip cannot make the
 * return over-refund the mirror figure — but a caller that needs to REFUSE must key on
 * `refundableCents == null` and treat headroom as unknown, not zero.
 *
 * Phase 1 of [[../../docs/brain/specs/internal-order-returns-blocked-by-refund-headroom-guard]]:
 * `getOrderRefundLedger` returns `{ok:false, reason:'no_shopify_order_id'}` BEFORE any Shopify call
 * for any order without a shopify_order_id — a structural fact, not a transient failure — so this
 * function distinguishes THAT reason (compute a local ceiling from `orders.total_cents` via
 * `deriveInternalRefundCeilingCents`, ok:true) from every OTHER reason (shopify_call_failed /
 * order_not_found / invalid_input — keep refundableCents=null so the caller's refuse-never-assume
 * branch still fires; a Shopify outage must not be downgraded into a local guess).
 */
export async function readReturnCreationRefundLedger(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  orderId: string,
): Promise<{ refundedCents: number; refundableCents: number | null; ok: boolean }> {
  let mirrorRefundedCents = 0;
  try {
    const { data } = await admin
      .from("order_refunds")
      .select("amount_cents, status")
      .eq("workspace_id", workspaceId)
      .eq("order_id", orderId);
    const rows = (data ?? []) as Array<{ amount_cents: number | null; status: string }>;
    for (const r of rows) {
      if (RETURN_REFUND_LEDGER_TERMINAL_STATUSES.has(String(r.status))) {
        mirrorRefundedCents += r.amount_cents ?? 0;
      }
    }
  } catch {
    mirrorRefundedCents = 0;
  }

  const ledger = await getOrderRefundLedger(workspaceId, orderId);
  if (ledger.ok) {
    return {
      refundedCents: ledger.refundedCents,
      refundableCents: ledger.refundableCents,
      ok: true,
    };
  }
  if (ledger.reason === "no_shopify_order_id") {
    // Internal (SHOPCX*) order — never existed in Shopify, so the Shopify ledger is structurally
    // absent, not transiently unreadable. Compute the ceiling locally from orders.total_cents
    // minus the mirror's terminal refunds. Any OTHER ledger failure reason falls through to the
    // refuse-never-assume branch below.
    let orderTotalCents = 0;
    try {
      const { data: order } = await admin
        .from("orders")
        .select("total_cents")
        .eq("id", orderId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      orderTotalCents = (order?.total_cents as number | null | undefined) ?? 0;
    } catch {
      orderTotalCents = 0;
    }
    return {
      refundedCents: mirrorRefundedCents,
      refundableCents: deriveInternalRefundCeilingCents({
        orderTotalCents,
        refundedCents: mirrorRefundedCents,
      }),
      ok: true,
    };
  }
  // Ledger unreadable for any other reason (Shopify down, order_not_found, invalid_input) — fall
  // through with the mirror sum so the caller still has a number, but refundableCents=null signals
  // "cannot verify the ceiling, must refuse on the creation-refusal check".
  return { refundedCents: mirrorRefundedCents, refundableCents: null, ok: false };
}

/**
 * Sum of terminal refunds ALREADY on the order — routes through [[refund-ledger]]
 * `getOrderRefundLedger` so out-of-band Shopify refunds count (Phase 2 of
 * [[../../docs/brain/specs/remedy-state-must-see-out-of-band-refunds]]). On a ledger failure
 * (Shopify down, non-Shopify order) falls back to the local `public.order_refunds` mirror sum so a
 * transient blip cannot make the return over-refund the mirror figure — but this is a strict
 * refunded-so-far read, not a ceiling. The creation-time refusal branch reads
 * `readReturnCreationRefundLedger` directly for the ledger's `refundableCents`.
 *
 * Kept as a thin wrapper for the [[../inngest/returns]] `returnsIssueRefund` refund-time re-check,
 * which uses this as one of several cascading caps (local mirror → local ledger → gateway
 * decideRefundReconcile).
 */
export async function sumSucceededOrderRefundsCents(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  orderId: string,
): Promise<number> {
  const { refundedCents } = await readReturnCreationRefundLedger(admin, workspaceId, orderId);
  return refundedCents;
}

// ── Recoverable-error class ──

/**
 * A return that didn't take in Shopify's mirror for a reason the CALLER
 * handles cleanly (null `data.return`, userErrors). createFullReturn surfaces
 * these as `{ success: false, error }` and the playbook/orchestrator escalate
 * or fall back — they're not bugs in our code, so we skip the
 * `console.error("[createFullReturn] Error:", …)` that otherwise reaches the
 * Vercel log drain and mints a Control Tower incident on every healthy
 * recovery (signature `vercel:314ca8c785aff3eb`).
 */
export class RecoverableShopifyReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverableShopifyReturnError";
  }
}

// ── Types ──

export interface CreateReturnParams {
  orderId: string;          // Our internal order UUID
  orderNumber: string;      // SC126222
  shopifyOrderGid: string;  // gid://shopify/Order/123
  customerId: string;
  ticketId?: string;
  resolutionType: "store_credit_return" | "refund_return" | "store_credit_no_return" | "refund_no_return";
  returnLineItems: { fulfillmentLineItemId: string; quantity: number; title: string }[];
  source: "playbook" | "agent" | "portal" | "ai" | "system";
}

export interface CreateReturnResult {
  returnId: string;
  shopifyReturnGid: string;
  reverseFulfillmentOrderGid: string | null;
}

export interface AttachTrackingParams {
  returnId: string;
  trackingNumber: string;
  trackingUrl?: string;
  carrier: string;
  labelUrl?: string;
}

export type Disposition = "RESTOCKED" | "MISSING" | "PROCESSING_REQUIRED" | "NOT_RESTOCKED";

export interface DisposeParams {
  returnId: string;
  disposition: Disposition;
  locationId?: string; // Required for RESTOCKED
}

export interface ReturnableItem {
  fulfillmentLineItemId: string;
  title: string;
  quantity: number;
  remainingQuantity: number;
  amountCents: number;
  currencyCode: string;
  variantId: string | null;
}

/** The subset of an `orders.line_items` entry the return synthesis reads. */
export interface OrderLineItemLite {
  sku?: string;
  title?: string;
  variant_title?: string | null;
  quantity?: number;
  price_cents?: number;
  /**
   * Per-line discount total in cents (sum across the line's units), mirrored from Shopify's
   * `total_discount` webhook field by [[shopify-webhooks]]. Read by
   * `deriveOrderSubtotalCentsFromLines` so the refundable subtotal matches what the customer
   * actually paid — see [[../../docs/brain/specs/return-net-refund-must-net-per-line-discounts]].
   */
  total_discount_cents?: number;
  variant_id?: string | number | null;
}

/**
 * Build return line items from an order's OWN `line_items` — the single source of truth for
 * [[createFullReturn]] now that we always synthesize our own return (never Shopify's return object,
 * which drops shippable lines that aren't in a fulfillment yet — the $6-only malformed returns).
 *
 * `amountCents` is the per-unit `price_cents` × quantity (line total, pre-tax). Zero/negative-qty
 * lines are dropped. `fulfillmentLineItemId` is empty (we create no Shopify reverse-fulfillment).
 * Pure + deterministic so the mapping is unit-tested independent of Shopify/EasyPost/DB.
 */
export function synthesizeReturnItemsFromLines(lines: OrderLineItemLite[] | null | undefined): ReturnableItem[] {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => (l.quantity ?? 0) > 0)
    .map((l) => ({
      fulfillmentLineItemId: "",
      title: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title || l.sku || "Item",
      quantity: l.quantity!,
      remainingQuantity: l.quantity!,
      amountCents: Math.round((l.price_cents || 0) * (l.quantity || 1)),
      currencyCode: "USD",
      variantId: l.variant_id != null ? String(l.variant_id) : null,
    }));
}

// ── 1. createShopifyReturn ──

const RETURN_CREATE_MUTATION = `
  mutation ReturnCreate($input: ReturnInput!) {
    returnCreate(returnInput: $input) {
      return {
        id
        status
        reverseFulfillmentOrders(first: 1) {
          nodes {
            id
            status
            lineItems(first: 50) {
              nodes {
                id
                totalQuantity
                fulfillmentLineItem {
                  id
                  lineItem { title quantity }
                }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

export async function createShopifyReturn(
  workspaceId: string,
  params: CreateReturnParams,
): Promise<CreateReturnResult> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const result = await shopifyGraphQL(shop, accessToken, RETURN_CREATE_MUTATION, {
    input: {
      orderId: params.shopifyOrderGid,
      returnLineItems: params.returnLineItems.map((item) => ({
        fulfillmentLineItemId: item.fulfillmentLineItemId,
        quantity: item.quantity,
        returnReason: "UNWANTED",
        returnReasonNote: `Return initiated via ${params.source}`,
      })),
      notifyCustomer: false,
    },
  });

  if (result.errors?.length) {
    throw new Error(`Shopify returnCreate error: ${result.errors[0].message}`);
  }

  const data = result.data?.returnCreate as {
    return: {
      id: string;
      status: string;
      reverseFulfillmentOrders: { nodes: { id: string; lineItems: { nodes: { id: string; totalQuantity: number; fulfillmentLineItem: { id: string } }[] } }[] };
    } | null;
    userErrors: { field: string; message: string }[];
  };

  if (data.userErrors?.length) {
    // Shopify-side validation (e.g. "Some return line items could not be
    // created", duplicate return, item already refunded). Caller-handled —
    // surface as a recoverable failure so createFullReturn's catch can
    // skip the console.error noise.
    throw new RecoverableShopifyReturnError(
      `Shopify returnCreate user error: ${data.userErrors[0].message}`,
    );
  }

  if (!data.return) {
    // Shopify accepted the mutation but didn't materialize a return record —
    // observed when the order has no returnable lines (already fully
    // returned, unfulfilled, etc.). The OUTER call site handles this via
    // {success: false}; treat it as a recoverable failure, not a bug.
    throw new RecoverableShopifyReturnError(
      "Shopify returnCreate returned null mirror — order has no returnable lines or Shopify rejected the return",
    );
  }

  const shopifyReturnGid = data.return.id;
  const rfo = data.return.reverseFulfillmentOrders.nodes[0];
  const reverseFulfillmentOrderGid = rfo?.id || null;

  // Store return_line_items with reverse fulfillment order line item IDs for later disposal
  const returnLineItemsWithRfoIds = params.returnLineItems.map((item) => {
    const rfoLineItem = rfo?.lineItems.nodes.find(
      (n) => n.fulfillmentLineItem.id === item.fulfillmentLineItemId,
    );
    return {
      shopify_fulfillment_line_item_id: item.fulfillmentLineItemId,
      shopify_rfo_line_item_id: rfoLineItem?.id || null,
      quantity: item.quantity,
      title: item.title,
    };
  });

  // Insert into our DB
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("returns")
    .insert({
      workspace_id: workspaceId,
      order_id: params.orderId,
      order_number: params.orderNumber,
      shopify_order_gid: params.shopifyOrderGid,
      customer_id: params.customerId,
      ticket_id: params.ticketId || null,
      shopify_return_gid: shopifyReturnGid,
      shopify_reverse_fulfillment_order_gid: reverseFulfillmentOrderGid,
      status: "open",
      resolution_type: params.resolutionType,
      source: params.source,
      return_line_items: returnLineItemsWithRfoIds,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to insert return: ${error.message}`);
  }

  return {
    returnId: row.id,
    shopifyReturnGid,
    reverseFulfillmentOrderGid,
  };
}

// ── 2. attachReturnTracking ──

// Shopify's reverseDeliveryCreateWithShipping requires:
//   - reverseDeliveryLineItems (added requirement — without it the API
//     returns "missing required arguments: reverseDeliveryLineItems")
//   - the returned ReverseDelivery type no longer exposes `status` or
//     `deliverable` fields in current Admin API versions; querying them
//     returns an undefinedField error
const REVERSE_DELIVERY_CREATE_MUTATION = `
  mutation ReverseDeliveryCreate(
    $reverseFulfillmentOrderId: ID!,
    $reverseDeliveryLineItems: [ReverseDeliveryLineItemInput!]!,
    $trackingInput: ReverseDeliveryTrackingInput,
    $labelInput: ReverseDeliveryLabelInput
  ) {
    reverseDeliveryCreateWithShipping(
      reverseFulfillmentOrderId: $reverseFulfillmentOrderId
      reverseDeliveryLineItems: $reverseDeliveryLineItems
      trackingInput: $trackingInput
      labelInput: $labelInput
      notifyCustomer: false
    ) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }
`;

export async function attachReturnTracking(
  workspaceId: string,
  params: AttachTrackingParams,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  // Get the return record + its line items (Shopify now requires them
  // on the reverseDeliveryCreateWithShipping mutation).
  const { data: ret } = await admin
    .from("returns")
    .select("shopify_reverse_fulfillment_order_gid, return_line_items")
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret?.shopify_reverse_fulfillment_order_gid) {
    return { success: false, error: "Return has no reverse fulfillment order" };
  }

  const lineItems = (ret.return_line_items as Array<{ shopify_rfo_line_item_id?: string; quantity?: number }> | null) || [];
  const reverseDeliveryLineItems = lineItems
    .filter((li) => li.shopify_rfo_line_item_id && li.quantity)
    .map((li) => ({
      reverseFulfillmentOrderLineItemId: li.shopify_rfo_line_item_id,
      quantity: li.quantity,
    }));

  if (reverseDeliveryLineItems.length === 0) {
    return { success: false, error: "Return has no line items to attach tracking to" };
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const variables: Record<string, unknown> = {
      reverseFulfillmentOrderId: ret.shopify_reverse_fulfillment_order_gid,
      reverseDeliveryLineItems,
      trackingInput: {
        number: params.trackingNumber,
        ...(params.trackingUrl && { url: params.trackingUrl }),
      },
    };

    if (params.labelUrl) {
      variables.labelInput = { fileUrl: params.labelUrl };
    }

    const result = await shopifyGraphQL(shop, accessToken, REVERSE_DELIVERY_CREATE_MUTATION, variables);

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.reverseDeliveryCreateWithShipping as {
      reverseDelivery: { id: string } | null;
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    // Update our DB
    await admin
      .from("returns")
      .update({
        shopify_reverse_delivery_gid: data.reverseDelivery?.id || null,
        tracking_number: params.trackingNumber,
        carrier: params.carrier,
        label_url: params.labelUrl || null,
        status: "label_created",
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to attach return tracking for ${params.returnId}:`, err);
    return { success: false, error: errText(err) };
  }
}

// ── 3. disposeReturnItems ──

const DISPOSE_MUTATION = `
  mutation DisposeItems($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems {
        id
        dispositionType
      }
      userErrors { field message }
    }
  }
`;

export async function disposeReturnItems(
  workspaceId: string,
  params: DisposeParams,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: ret } = await admin
    .from("returns")
    .select("return_line_items, shopify_reverse_fulfillment_order_gid")
    .eq("id", params.returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret) {
    return { success: false, error: "Return not found" };
  }

  const lineItems = ret.return_line_items as {
    shopify_rfo_line_item_id: string | null;
    quantity: number;
  }[];

  const dispositionInputs = lineItems
    .filter((item) => item.shopify_rfo_line_item_id)
    .map((item) => ({
      reverseFulfillmentOrderLineItemId: item.shopify_rfo_line_item_id,
      quantity: item.quantity,
      dispositionType: params.disposition,
      ...(params.disposition === "RESTOCKED" && params.locationId && { locationId: params.locationId }),
    }));

  if (dispositionInputs.length === 0) {
    return { success: false, error: "No line items with reverse fulfillment order IDs to dispose" };
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const result = await shopifyGraphQL(shop, accessToken, DISPOSE_MUTATION, { dispositionInputs });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.reverseFulfillmentOrderDispose as {
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    await admin
      .from("returns")
      .update({
        status: "restocked",
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to dispose return items for ${params.returnId}:`, err);
    return { success: false, error: errText(err) };
  }
}

// ── 4. processReturn (all-in-one: dispose + refund + close) ──

const RETURN_PROCESS_MUTATION = `
  mutation ReturnProcess($input: ReturnProcessInput!) {
    returnProcess(returnProcessInput: $input) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export async function processReturn(
  workspaceId: string,
  returnId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: ret } = await admin
    .from("returns")
    .select("shopify_return_gid, return_line_items")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret?.shopify_return_gid) {
    return { success: false, error: "Return not found or missing Shopify GID" };
  }

  // We need Shopify ReturnLineItem IDs for processReturn — query them
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    // First, fetch the return's line items from Shopify
    const queryResult = await shopifyGraphQL(shop, accessToken, `
      query ReturnLineItems($id: ID!) {
        return(id: $id) {
          returnLineItems(first: 50) {
            nodes { id quantity }
          }
        }
      }
    `, { id: ret.shopify_return_gid });

    const returnData = (queryResult.data?.return as { returnLineItems: { nodes: { id: string; quantity: number }[] } }) || null;
    if (!returnData?.returnLineItems?.nodes?.length) {
      return { success: false, error: "No return line items found in Shopify" };
    }

    const result = await shopifyGraphQL(shop, accessToken, RETURN_PROCESS_MUTATION, {
      input: {
        returnId: ret.shopify_return_gid,
        returnLineItems: returnData.returnLineItems.nodes.map((n) => ({
          id: n.id,
          quantity: n.quantity,
        })),
      },
    });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.returnProcess as {
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    await admin
      .from("returns")
      .update({
        status: "closed",
        processed_at: new Date().toISOString(),
        refunded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to process return ${returnId}:`, err);
    return { success: false, error: errText(err) };
  }
}

// ── 5. closeReturn ──

const RETURN_CLOSE_MUTATION = `
  mutation ReturnClose($id: ID!) {
    returnClose(id: $id) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export async function closeReturn(
  workspaceId: string,
  returnId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  const { data: ret } = await admin
    .from("returns")
    .select("shopify_return_gid")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret) {
    return { success: false, error: "Return not found" };
  }

  // Internal-order path: createFullReturn (see the comment above the returns
  // insert) never creates a Shopify RETURN, so shopify_return_gid stays null
  // by design. Documented no-op — nothing to close on Shopify's side.
  if (!ret.shopify_return_gid) {
    return { success: true };
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const result = await shopifyGraphQL(shop, accessToken, RETURN_CLOSE_MUTATION, {
      id: ret.shopify_return_gid,
    });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const data = result.data?.returnClose as {
      userErrors: { message: string }[];
    };

    if (data.userErrors?.length) {
      return { success: false, error: data.userErrors[0].message };
    }

    await admin
      .from("returns")
      .update({
        status: "closed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", returnId);

    return { success: true };
  } catch (err) {
    console.error(`Failed to close return ${returnId}:`, err);
    return { success: false, error: errText(err) };
  }
}

// ── 6. getReturnableItems ──

const ORDER_RETURNABLE_QUERY = `
  query OrderReturnable($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillments {
        id
        status
        fulfillmentLineItems(first: 50) {
          nodes {
            id
            originalTotalSet {
              shopMoney { amount currencyCode }
            }
            quantity
            lineItem {
              title
              variant {
                id
              }
            }
          }
        }
      }
      returns(first: 10) {
        nodes {
          id
          status
          returnLineItems(first: 50) {
            nodes {
              id
              quantity
            }
          }
        }
      }
    }
  }
`;

export async function getReturnableItems(
  workspaceId: string,
  shopifyOrderGid: string,
): Promise<ReturnableItem[]> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const result = await shopifyGraphQL(shop, accessToken, ORDER_RETURNABLE_QUERY, {
    id: shopifyOrderGid,
  });

  if (result.errors?.length) {
    throw new Error(`Shopify order query error: ${result.errors[0].message}`);
  }

  const order = result.data?.order as {
    fulfillments: {
      id: string;
      status: string;
      fulfillmentLineItems: {
        nodes: {
          id: string;
          originalTotalSet: { shopMoney: { amount: string; currencyCode: string } };
          quantity: number;
          lineItem: {
            title: string;
            variant: { id: string } | null;
          };
        }[];
      };
    }[];
    returns: {
      nodes: {
        id: string;
        status: string;
        returnLineItems: {
          nodes: {
            id: string;
            quantity: number;
          }[];
        };
      }[];
    };
  } | null;

  if (!order) {
    throw new Error("Order not found in Shopify");
  }

  // Build count of already-returned items (exclude CANCELED returns)
  let totalReturnedQuantity = 0;
  for (const ret of order.returns.nodes) {
    if (ret.status === "CANCELED") continue;
    for (const item of ret.returnLineItems.nodes) {
      totalReturnedQuantity += item.quantity;
    }
  }

  // Collect returnable items from fulfilled orders
  const items: ReturnableItem[] = [];
  for (const fulfillment of order.fulfillments) {
    if (fulfillment.status !== "SUCCESS") continue;

    for (const fli of fulfillment.fulfillmentLineItems.nodes) {
      const alreadyReturned = totalReturnedQuantity; // Simplified: if any returns exist, reduce remaining
      const remaining = fli.quantity - alreadyReturned;
      if (remaining <= 0) continue;

      const amountCents = Math.round(parseFloat(fli.originalTotalSet.shopMoney.amount) * 100);

      items.push({
        fulfillmentLineItemId: fli.id,
        title: fli.lineItem.title,
        quantity: fli.quantity,
        remainingQuantity: remaining,
        amountCents,
        currencyCode: fli.originalTotalSet.shopMoney.currencyCode,
        variantId: fli.lineItem.variant?.id || null,
      });
    }
  }

  return items;
}

// ── 7. createFullReturn — unified helper for the complete return flow ──
// Used by: Sonnet actions, playbook executor, manual scripts
// 1. Get returnable items from Shopify
// 2. Create return in Shopify + our DB
// 3. Buy cheapest EasyPost label
// 4. Attach tracking to Shopify + update our DB

export interface FullReturnParams {
  workspaceId: string;
  orderId: string;          // Our internal order UUID
  orderNumber: string;      // SC126222
  /** gid://shopify/Order/123, or `null` for an INTERNAL order (SHOPCX*, no Shopify order) — the
   *  internal path skips the Shopify return-create + builds the return from the order's own line_items. */
  shopifyOrderGid: string | null;
  customerId: string;
  ticketId?: string;
  customerName: string;
  customerPhone?: string;
  shippingAddress: {
    street1: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
  };
  resolutionType?: "refund_return" | "store_credit_return";
  source?: "playbook" | "agent" | "portal" | "ai" | "system";
  freeLabel?: boolean; // If true, don't deduct label cost from refund (crisis returns)
}

export interface FullReturnResult {
  success: boolean;
  returnId?: string;
  trackingNumber?: string;
  labelUrl?: string;
  carrier?: string;
  labelCostCents?: number;
  error?: string;
}

export async function createFullReturn(params: FullReturnParams): Promise<FullReturnResult> {
  const admin = createAdminClient();

  try {
    // 1. Returnable items + 2. the return record — ALWAYS synthesized from the order's own
    // line_items, never Shopify's return object (founder decision, 2026-07).
    //
    // WHY: Shopify won't accept a shippable line item onto a return object before it's in a
    // fulfillment, so a Shopify-created return silently drops everything except Shipping
    // Protection — the malformed $6-only returns (Amy SC133495, Kim SC134360, Ann's coffees) all
    // captured just the $6 protection line and shorted the customer the actual product refund. For
    // an instant refund we can NEVER build the "perfect return" in Shopify, so we don't try: we
    // build our OWN returns row from line_items and buy the EasyPost label directly.
    //
    // The label is address-based (not Shopify-based) and the delivered-refund path
    // ([[inngest/returns]] returnsIssueRefund) reads net_refund_cents + order_id → refundOrder
    // (gateway-routed) — it never touches the Shopify return object. We keep shopify_order_gid on
    // the row (the ORDER still exists in Shopify; it's NOT a return gid) but create no Shopify
    // RETURN, so shopify_return_gid / reverse-fulfillment stay null. closeReturn + item disposal
    // no-op gracefully on a null return gid — already true for the internal-order path this
    // generalizes.
    const { data: order } = await admin
      .from("orders")
      .select("line_items, total_cents")
      .eq("id", params.orderId)
      .maybeSingle();
    const orderLineItems = (order?.line_items as OrderLineItemLite[] | null) ?? null;
    const items = synthesizeReturnItemsFromLines(orderLineItems);
    if (items.length === 0) {
      return { success: false, error: "No returnable line items on this order" };
    }

    // Phase 2 § "refuse before spending money, and never leave a blocking stub" of
    // [[../../docs/brain/specs/internal-order-returns-blocked-by-refund-headroom-guard]] — the
    // refund-headroom guard runs HERE, BEFORE any irreversible step (returns row insert, EasyPost
    // shipment create, EasyPost buy). All inputs are DB reads (order.total_cents + line_items +
    // refund ledger) with NO dependency on the shipment, so the block moves cleanly.
    //
    // The pre-label net is a WORST-CASE: labelCostCents=0 gives the LARGEST possible net_refund
    // (any real label deducted post-purchase only shrinks it), so a pass here is a pass after
    // buy — one check upstream replaces the old post-buy check that could refuse only after burning
    // a paid label. The final `net_refund_cents` stored on the row still uses the ACTUAL label
    // (computed after buy, below), matching the [[../tables/policies|`returns` policy]] formula.
    //
    // "Leave no residue" choice: DEFER the returns INSERT until AFTER this check passes (rather
    // than delete-on-refusal). A refusal creates no row at all, so the `.neq('status','cancelled')`
    // one-return-per-ticket guard in `src/lib/action-executor.ts` cannot see a leftover open stub —
    // the exact block that stranded ticket 6b0cd91c (Denise Richling, 2026-08-28) after PR #2557.
    // Deferring is simpler and race-free vs a delete on the refusal path.
    const orderSubtotalCents = deriveOrderSubtotalCentsFromLines(orderLineItems);
    const refundLedger = await readReturnCreationRefundLedger(admin, params.workspaceId, params.orderId);
    const preLabelNetRefundCents = computeReturnNetRefundCents({
      orderSubtotalCents,
      labelCostCents: 0,
      refundsSucceededCents: refundLedger.refundedCents,
    });
    const headroom = assertReturnRefundHeadroom({
      netRefundCents: preLabelNetRefundCents,
      refundableCents: refundLedger.refundableCents,
      orderNumber: params.orderNumber,
    });
    if (!headroom.ok) {
      return { success: false, error: headroom.error };
    }

    const { data: row, error: insErr } = await admin
      .from("returns")
      .insert({
        workspace_id: params.workspaceId,
        order_id: params.orderId,
        order_number: params.orderNumber,
        // null for an internal SHOPCX* order; the ORDER gid for a Shopify order (never a return gid).
        shopify_order_gid: params.shopifyOrderGid,
        customer_id: params.customerId,
        ticket_id: params.ticketId ?? null,
        resolution_type: params.resolutionType || "refund_return",
        source: params.source || "ai",
        status: "open",
        return_line_items: items.map((i) => ({ title: i.title, quantity: i.remainingQuantity, variant_id: i.variantId })),
      })
      .select("id")
      .single();
    if (insErr || !row) {
      return { success: false, error: `Failed to create return: ${insErr?.message || "unknown"}` };
    }
    const returnResult: { returnId: string; reverseFulfillmentOrderGid: string | null } = {
      returnId: row.id,
      reverseFulfillmentOrderGid: null,
    };

    // 3. Buy cheapest EasyPost label
    const { data: ws } = await admin.from("workspaces")
      .select("easypost_live_api_key_encrypted, return_address, default_return_parcel")
      .eq("id", params.workspaceId).single();

    if (!ws?.easypost_live_api_key_encrypted) {
      return { success: true, returnId: returnResult.returnId, error: "EasyPost not configured — return created without label" };
    }

    const { decrypt } = await import("@/lib/crypto");
    const easypostKey = decrypt(ws.easypost_live_api_key_encrypted);
    const returnAddr = ws.return_address as Record<string, string>;
    const parcel = (ws.default_return_parcel || { length: 12, width: 10, height: 6, weight: 16 }) as Record<string, number>;

    const shipmentRes = await fetch("https://api.easypost.com/v2/shipments", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(easypostKey + ":"), "Content-Type": "application/json" },
      body: JSON.stringify({
        shipment: {
          from_address: {
            name: params.customerName,
            street1: params.shippingAddress.street1,
            city: params.shippingAddress.city,
            state: params.shippingAddress.state,
            zip: params.shippingAddress.zip,
            country: params.shippingAddress.country || "US",
            phone: params.customerPhone || "0000000000",
          },
          to_address: {
            name: returnAddr.name,
            street1: returnAddr.street1,
            street2: returnAddr.street2 || "",
            city: returnAddr.city,
            state: returnAddr.state,
            zip: returnAddr.zip,
            country: returnAddr.country || "US",
            phone: returnAddr.phone,
          },
          parcel: { length: parcel.length, width: parcel.width, height: parcel.height, weight: parcel.weight },
        },
      }),
    });

    const shipment = await shipmentRes.json();
    if (!shipmentRes.ok) {
      return { success: true, returnId: returnResult.returnId, error: `EasyPost shipment error: ${shipment?.error?.message || "unknown"}` };
    }

    // Pin carrier to USPS. We used to grab the absolute cheapest rate
    // across all carriers, which made labels bounce between USPS and
    // FedEx unpredictably — bad customer UX because the email always
    // says "drop at any USPS location" but the actual label might say
    // FedEx. USPS has the most drop-off locations and works for the
    // overwhelming majority of return shipments. Only fall back to
    // whatever's cheapest if USPS returned no rates at all (rare —
    // usually means a parcel-spec validation issue on EasyPost's side).
    type Rate = { id: string; rate: string; carrier?: string };
    const allRates = (shipment.rates || []) as Rate[];
    if (allRates.length === 0) {
      return { success: true, returnId: returnResult.returnId, error: "No shipping rates available" };
    }
    const sortByPrice = (a: Rate, b: Rate) => parseFloat(a.rate) - parseFloat(b.rate);
    const usps = allRates.filter((r) => (r.carrier || "").toUpperCase() === "USPS").sort(sortByPrice);
    const chosen = usps[0] || allRates.slice().sort(sortByPrice)[0];

    const buyRes = await fetch(`https://api.easypost.com/v2/shipments/${shipment.id}/buy`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(easypostKey + ":"), "Content-Type": "application/json" },
      body: JSON.stringify({ rate: { id: chosen.id } }),
    });

    const purchased = await buyRes.json();
    if (!buyRes.ok) {
      return { success: true, returnId: returnResult.returnId, error: `EasyPost buy error: ${purchased?.error?.message || "unknown"}` };
    }

    const trackingNumber = purchased.tracking_code;
    const labelUrl = purchased.postage_label?.label_url;
    const carrier = purchased.selected_rate?.carrier || "Unknown";
    const labelCostCents = Math.round(parseFloat(purchased.selected_rate?.rate || "0") * 100);

    // 4. Attach tracking to Shopify + update our DB
    if (returnResult.reverseFulfillmentOrderGid) {
      await attachReturnTracking(params.workspaceId, {
        returnId: returnResult.returnId,
        trackingNumber,
        carrier,
        labelUrl,
      });
    }

    // Compute the FINAL net_refund_cents commitment now that EasyPost has told us the actual
    // label cost. `orderSubtotalCents` + `refundLedger` were already resolved upstream for the
    // pre-purchase headroom check (they're DB-only and cheap), so we reuse them here and only
    // recompute with the actual label. Phase 3 of remedy-state-must-see-out-of-band-refunds — the
    // `returns` policy says net_refund = order_subtotal - label_cost and explicitly excludes
    // Shipping Protection; the DB still stores `order_total_cents` for audit (the customer-paid
    // figure). The downstream pipeline reads net_refund_cents as the contract and never re-derives.
    const orderTotalForAudit = (order?.total_cents as number | null | undefined) ?? 0;
    const finalLabelCostCents = params.freeLabel ? 0 : labelCostCents;
    const netRefundCents = computeReturnNetRefundCents({
      orderSubtotalCents,
      labelCostCents: finalLabelCostCents,
      refundsSucceededCents: refundLedger.refundedCents,
    });

    // Update our DB with EasyPost details + the refund commitment.
    // Status advances to label_created independently of
    // attachReturnTracking's success — the customer has the label
    // and that's the customer-facing truth. Shopify-side
    // reverse-delivery is a nice-to-have for inventory tracking but
    // shouldn't gate our status.
    await admin.from("returns").update({
      easypost_shipment_id: shipment.id,
      label_cost_cents: finalLabelCostCents,
      order_total_cents: orderTotalForAudit,
      net_refund_cents: netRefundCents,
      tracking_number: trackingNumber || null,
      label_url: labelUrl || null,
      carrier: carrier || null,
      status: "label_created",
      updated_at: new Date().toISOString(),
    }).eq("id", returnResult.returnId);

    return {
      success: true,
      returnId: returnResult.returnId,
      trackingNumber,
      labelUrl,
      carrier,
      labelCostCents: params.freeLabel ? 0 : labelCostCents,
    };
  } catch (err) {
    // Recoverable failures (null Shopify mirror / Shopify userErrors / known
    // EasyPost configuration gaps) are caller-handled via {success: false}
    // and shouldn't churn the Control Tower error feed — the Vercel log
    // drain captures every `console.error` and mints a paged incident on a
    // healthy recovery path (signature `vercel:314ca8c785aff3eb`). Skip the
    // log for that class; keep it for unexpected throws so a real bug still
    // surfaces.
    if (err instanceof RecoverableShopifyReturnError) {
      return { success: false, error: err.message };
    }
    console.error("[createFullReturn] Error:", err);
    return { success: false, error: errText(err) };
  }
}
