/**
 * Honest three-state order-status classifier for the customer portal.
 *
 * The old renderer ran a four-tone state machine of "Shipped / Cancelled /
 * Refunded / Processing / (blank)" that depended on `amplifier_status` — a
 * legacy field that was never populated for internal orders written before the
 * Amplifier sync, and never populated for Shopify orders at all. Old orders +
 * internal-fulfilled orders ended up in a permanent "Processing" limbo (or
 * blank), and the portal read as "we haven't shipped your box" for boxes that
 * had shipped 8 months ago. Enough migrated customers hit this that the
 * portal-first-delivery-gate spec Phase 3 replaced it with the three-state
 * classifier below.
 *
 * The three states — Created → Shipped → Delivered — are TERMINAL forward:
 *   - Created: paid, no delivery signal yet
 *   - Shipped: fulfilled OR has tracking; internal orders that are paid + aged
 *     count too (Amplifier never sends us a delivered event, so we infer)
 *   - Delivered: delivered_at is stamped OR EasyPost says delivered
 *
 * Cancelled and Refunded are SEPARATE tags (financial states) — they don't
 * displace the delivery state; they carry different information.
 *
 * Internal-vs-Shopify is determined per ORDER via `shopify_order_id` (NULL =
 * internal). We keyed the whole first-delivery gate on the sub's `is_internal`
 * flag before Phase 1; migrated subs (is_internal=true but SC-numbered Shopify
 * orders) broke every branch that trusted the flag. This module makes the same
 * mistake impossible for order-status rendering by keying on the order.
 */

/** The order fields this module reads. Deliberately minimal so the caller can
 *  pass any object satisfying it (server row, wire payload, test fixture). */
export interface OrderStatusInput {
  /** NULL = internal (Amplifier-fulfilled) · non-null = Shopify. */
  shopify_order_id?: string | null;
  /** Shopify fulfillment marker; "fulfilled"/"partial"/"partially_fulfilled" = shipped. */
  fulfillment_status?: string | null;
  /** Confirmed delivery timestamp; presence => Delivered (terminal). */
  delivered_at?: string | null;
  /** EasyPost tracker status; "delivered" => Delivered. */
  easypost_status?: string | null;
  /** Amplifier tracking number for internal orders; presence => Shipped. */
  amplifier_tracking_number?: string | null;
  /** Legacy Amplifier status; "Shipped"/"Cancelled" survive as inputs. */
  amplifier_status?: string | null;
  /** paid / refunded / partially_refunded / voided. */
  financial_status?: string | null;
  /** Order created timestamp — drives the internal-order aged-fallback to Shipped. */
  created_at: string;
}

export interface OrderStatusTag {
  /** Human-readable badge label. */
  label: "Created" | "Shipped" | "Delivered" | "Cancelled" | "Refunded";
  /** Semantic tone the renderer maps to Tailwind classes. */
  tone: "zinc" | "sky" | "emerald" | "amber";
}

/** Internal order with no tracking + paid + this old = infer Shipped. Same
 *  window the mutation-guard uses for the internal-fulfilled grace — the
 *  Amplifier pipeline never sends a delivered event, so a 7-day paid box is
 *  our best "at least Shipped" signal. */
const INTERNAL_AGED_SHIPPED_MS = 7 * 24 * 60 * 60 * 1000;

const FULFILLED_STATUSES = new Set(["fulfilled", "delivered", "partial", "partially_fulfilled"]);

/**
 * Delivery-lane classifier. Returns Created / Shipped / Delivered — never
 * "in transit" or "processing". Cancelled/Refunded are financial tags handled
 * separately (see financialTag).
 */
export function deliveryStatusTag(o: OrderStatusInput, now: number): OrderStatusTag {
  // Delivered: terminal, cheapest to detect. delivered_at OR EasyPost.
  if (o.delivered_at || String(o.easypost_status || "").toLowerCase() === "delivered") {
    return { label: "Delivered", tone: "emerald" };
  }

  const isInternalOrder = o.shopify_order_id == null;
  const ff = String(o.fulfillment_status || "").toLowerCase();
  const isFulfilledLike = FULFILLED_STATUSES.has(ff);

  if (isInternalOrder) {
    // Internal: has tracking OR is fulfilled OR is aged-past-7d ⇒ Shipped.
    if (o.amplifier_tracking_number) return { label: "Shipped", tone: "sky" };
    if (isFulfilledLike) return { label: "Shipped", tone: "sky" };
    // Legacy amplifier_status is still authoritative when set to Shipped —
    // older orders were tagged via that field before we stored delivered_at.
    if (String(o.amplifier_status || "").toLowerCase() === "shipped") return { label: "Shipped", tone: "sky" };
    // Aged fallback: a paid internal order older than the grace window has
    // shipped even if the ETL never wrote a fulfillment_status. Only apply
    // when the order isn't refunded/voided — those aren't shipped.
    const isPaid = !["refunded", "partially_refunded", "voided"].includes(String(o.financial_status || "").toLowerCase());
    if (isPaid) {
      const createdAt = new Date(o.created_at).getTime();
      if (now - createdAt > INTERNAL_AGED_SHIPPED_MS) return { label: "Shipped", tone: "sky" };
    }
    // Fresh internal, no tracking, not fulfilled ⇒ Created.
    return { label: "Created", tone: "zinc" };
  }

  // Shopify order: fulfillment_status is the delivery proxy.
  if (isFulfilledLike) return { label: "Shipped", tone: "sky" };
  if (o.amplifier_tracking_number) return { label: "Shipped", tone: "sky" };
  return { label: "Created", tone: "zinc" };
}

/**
 * Financial tag rendered separately from the delivery tag. Cancelled and
 * Refunded are their own information ("this order didn't happen" / "we
 * refunded it") and don't displace where the box got to. Returns null when
 * the financial state is uninteresting (paid / pending).
 */
export function financialTag(o: OrderStatusInput): OrderStatusTag | null {
  const amp = String(o.amplifier_status || "").toLowerCase();
  if (amp === "cancelled" || amp === "canceled") return { label: "Cancelled", tone: "zinc" };
  const fin = String(o.financial_status || "").toLowerCase();
  if (fin === "voided") return { label: "Cancelled", tone: "zinc" };
  if (fin === "refunded" || fin === "partially_refunded") return { label: "Refunded", tone: "amber" };
  return null;
}
