/**
 * Pure CX-surface derivation for review-request personalization.
 *
 * Ground the post-order review-ask copy in the customer's actual order +
 * subscription history — NOT `customers.created_at`, and NOT the detector's
 * per-order first-time flag alone. The failing case this exists to prevent is
 * ticket `7e3ee827-7297-4229-be57-7c86c80214a0`: an ~8-month repeat Amazing
 * Coffee subscriber across 3 contracts (1 active, 2 cancelled) received a
 * post-order review ask telling her "You tried Amazing Coffee for the first
 * time — you've been with us about 5 months". Root cause was two-fold:
 *
 *   1. The detector's first-time classifier read only `orders.line_items` for
 *      the anchor customer_id — it did not merge across linked identities and
 *      it did not consult `subscriptions.items`. Her earlier AC purchases sat
 *      on other rows of the same person + inside subscription contracts, so
 *      the anchor order looked like the first time.
 *   2. The sender fed `tenureDays` from `customer.created_at` — the account
 *      creation date — instead of her earliest observable activity. Her
 *      account was created ~5 months ago; her earliest AC order was 8 months
 *      ago.
 *
 * The fix is to derive both signals from the merged surface across linked
 * customer ids: any prior order OR any (active OR cancelled) subscription
 * carrying this product proves REPEAT; the tenure fact is the earliest
 * observed activity across the same merged set. When we cannot positively
 * verify a claim (blind history, no observable activity), we return `null` and
 * the composer falls back to a neutral opening that asserts nothing.
 *
 * Kept PURE + centralized so both the sender's DB probes and the pins in
 * [[./review-request-cx-surface.test]] share ONE implementation of the
 * "verify before you claim" rule. See also
 * [[../inngest/post-order-review-ask-detector-cron]] for the upstream
 * per-order classifier and [[./review-request-compose]] for the copy shapes.
 */

/**
 * Every identifier that maps to the SAME internal product — computed once from
 * `product_variants` joined to `products` for the target productId. The
 * membership check below runs against ANY of these shapes so an order/sub that
 * only knows the shopify id, only knows a variant uuid, or only carries a SKU
 * still resolves to a hit.
 */
export interface ProductIdentityFingerprint {
  internalProductId: string;
  shopifyProductId: string | null;
  /** `product_variants.id` — internal UUIDs. Subscription items on internal
   *  subs reference these. */
  variantUuids: Set<string>;
  /** `product_variants.shopify_variant_id` — Shopify numeric strings. Order
   *  line items and Appstle-shape subscription items reference these. */
  shopifyVariantIds: Set<string>;
  /** SKUs. Any line-item shape falls back to this. */
  skus: Set<string>;
}

export interface CxSurfaceOrder {
  id: string;
  created_at: string | null;
  line_items: unknown;
}

export interface CxSurfaceSubscription {
  id: string;
  /** Preferred origin timestamp (Appstle carries the contract-created moment
   *  here). Falls back to `created_at` when null. */
  subscription_created_at: string | null;
  created_at: string | null;
  items: unknown;
}

/**
 * The derived personalization the sender hands to the composer. `window=null`
 * / `tenureDays=null` are the WITHHOLD signals — the composer emits its
 * neutral opening for either.
 */
export interface DerivedCxPersonalization {
  /** Composer window label — `"repeat"` if the surface shows a prior purchase
   *  of THIS product, `"first-time"` only when the surface is visible AND has
   *  no prior purchase, `null` when we cannot positively verify either. */
  window: "first-time" | "repeat" | null;
  /** Days between now and the earliest observed activity across the merged
   *  surface. `null` when no activity was observable (or every date parsed
   *  to NaN) — the composer's tenure phrase is skipped entirely. */
  tenureDays: number | null;
  /** Debug — a machine-readable reason the derivation withheld a claim.
   *  Surfaced for the future logging hook + the contradiction-guard test. */
  withheldReason: "history_blind" | "no_activity_observed" | null;
  /** True iff the CX surface itself positively shows a prior purchase — i.e.
   *  a `first-time` claim from the upstream detector would DIRECTLY contradict
   *  this surface. The guard test reads this to fail the release if the copy
   *  ever tries to say "first time" against a repeat customer. */
  surfaceShowsRepeat: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure derivation. See the module docstring for the failing case this exists
 * to prevent. Kept a plain function over primitives so it is trivially
 * testable without a DB.
 */
export function deriveCxSurfacePersonalization(input: {
  orders: CxSurfaceOrder[];
  subscriptions: CxSurfaceSubscription[];
  product: ProductIdentityFingerprint;
  /** The order that triggered THIS review ask — excluded from the "prior
   *  purchase" scan so its own line does not count as evidence of repeat. */
  anchorOrderId?: string | null;
  now: number;
}): DerivedCxPersonalization {
  const priorOrders = input.orders.filter((o) => o.id !== input.anchorOrderId);

  // 1) Prior-purchase check — walk every readable order line + every
  //    subscription item; a single hit proves REPEAT.
  let boughtBefore = false;
  let orderHistoryReadable = false;
  let orderHistoryPartiallyBlind = false;
  for (const o of priorOrders) {
    const items = Array.isArray(o.line_items) ? o.line_items : [];
    let orderReadable = false;
    for (const raw of items) {
      const hit = lineMatchesProduct(raw, input.product);
      if (hit) boughtBefore = true;
      if (hit || lineIsReadable(raw)) orderReadable = true;
    }
    if (orderReadable) orderHistoryReadable = true;
    else if (items.length > 0) orderHistoryPartiallyBlind = true;
  }
  let subHistoryReadable = false;
  for (const s of input.subscriptions) {
    const items = Array.isArray(s.items) ? s.items : [];
    let subReadable = false;
    for (const raw of items) {
      const hit = lineMatchesProduct(raw, input.product);
      if (hit) boughtBefore = true;
      if (hit || lineIsReadable(raw)) subReadable = true;
    }
    if (subReadable) subHistoryReadable = true;
  }
  // A customer with ZERO prior orders + ZERO subs is a first-time buyer with
  // full visibility (there's nothing to be blind about). Otherwise every
  // enumerated source has to be readable before we assert "first-time".
  const noHistoryAtAll = priorOrders.length === 0 && input.subscriptions.length === 0;
  const historyVisible = noHistoryAtAll
    ? true
    : (orderHistoryReadable || priorOrders.length === 0) &&
      !orderHistoryPartiallyBlind &&
      (subHistoryReadable || input.subscriptions.length === 0);

  // 2) Earliest activity — min over (readable) orders' created_at + every
  //    subscription's subscription_created_at (fallback created_at). Used
  //    for tenure. A customer whose ONLY activity is the anchor order gets
  //    tenureDays = 0 which the composer's `>= 30` gate skips.
  let earliestMs: number | null = null;
  const consider = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    if (earliestMs === null || t < earliestMs) earliestMs = t;
  };
  for (const o of input.orders) consider(o.created_at);
  for (const s of input.subscriptions) {
    consider(s.subscription_created_at);
    if (!s.subscription_created_at) consider(s.created_at);
  }
  const tenureDays =
    earliestMs === null
      ? null
      : Math.max(0, Math.floor((input.now - earliestMs) / DAY_MS));

  // 3) Decide the claim.
  //    - `repeat` wins whenever the surface shows a prior purchase.
  //    - `first-time` requires positive visibility across the surface.
  //    - null withholds the claim; the composer's neutral opening asserts
  //      nothing about the customer's history.
  let window: "first-time" | "repeat" | null;
  let withheldReason: DerivedCxPersonalization["withheldReason"] = null;
  if (boughtBefore) {
    window = "repeat";
  } else if (historyVisible) {
    window = "first-time";
  } else {
    window = null;
    withheldReason = "history_blind";
  }
  // Tenure withhold: no activity ⇒ no tenure phrase. Not a "reason" in the
  // window sense but surfaced separately so a caller telemetry can split
  // "we can't say first-time" from "we can't say how long".
  if (withheldReason === null && tenureDays === null) {
    withheldReason = "no_activity_observed";
  }

  return {
    window,
    tenureDays,
    withheldReason,
    surfaceShowsRepeat: boughtBefore,
  };
}

/**
 * True iff the anchored claim in the copy DIRECTLY contradicts the CX surface.
 * Used by the sender's pre-send guard + the pin in the compose test. The
 * failing case: "you tried it for the first time" shipped to a customer whose
 * surface shows prior purchases of the same product.
 */
export function personalizationContradictsSurface(input: {
  claim: DerivedCxPersonalization;
  proposedWindow: "first-time" | "repeat" | null;
}): boolean {
  if (input.proposedWindow === "first-time" && input.claim.surfaceShowsRepeat) {
    return true;
  }
  return false;
}

/**
 * True iff we have any identifier at all on the line — used to distinguish a
 * genuinely-blind order line (all keys absent) from a readable one that
 * simply resolved to a different product.
 */
function lineIsReadable(raw: unknown): boolean {
  const li = raw as
    | { product_id?: unknown; variant_id?: unknown; sku?: unknown }
    | null
    | undefined;
  if (!li) return false;
  if (typeof li.product_id === "string" && li.product_id.length > 0) return true;
  if (typeof li.variant_id === "string" && li.variant_id.length > 0) return true;
  if (typeof li.sku === "string" && li.sku.length > 0) return true;
  return false;
}

/**
 * Membership check — does this line item match the product? Kept generous
 * because the same product surfaces under different shapes across the app:
 *
 *   • orders.line_items (Shopify webhook): `product_id` numeric string,
 *     `variant_id` numeric string, `sku` string.
 *   • subscriptions.items (Appstle): variant_id numeric string, sku.
 *   • subscriptions.items (internal): `product_id` UUID, `variant_id` UUID.
 *
 * A hit on any shape counts. The order the checks run does not matter — this
 * is a pure "did the customer ever buy this?" question.
 */
function lineMatchesProduct(raw: unknown, product: ProductIdentityFingerprint): boolean {
  const li = raw as
    | {
        product_id?: unknown;
        variant_id?: unknown;
        sku?: unknown;
      }
    | null
    | undefined;
  if (!li) return false;
  const pid = li.product_id;
  if (typeof pid === "string" && pid.length > 0) {
    if (pid === product.internalProductId) return true;
    if (product.shopifyProductId && pid === product.shopifyProductId) return true;
  }
  const vid = li.variant_id;
  if (typeof vid === "string" && vid.length > 0) {
    if (product.variantUuids.has(vid)) return true;
    if (product.shopifyVariantIds.has(vid)) return true;
  }
  const sku = li.sku;
  if (typeof sku === "string" && sku.length > 0 && product.skus.has(sku)) {
    return true;
  }
  return false;
}
