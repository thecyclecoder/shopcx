/**
 * Crisis-swap-rejected classifier + refund plan builder — Phase 1 of
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * When a crisis-enrolled customer's renewal has already charged and the order that
 * will ship carries the `default_swap` variant (because their ordered flavor is
 * OOS), the customer sometimes signals they REJECT the substitute — "berry only",
 * "no substitutions", "I'll wait". Sol must recognize this pattern as a
 * **crisis-swap-rejected** order and flag it for a FULL refund of the order's
 * remaining balance (order_total − prior refunds), NEVER a price-correction
 * partial (that path — [[../subscription-overcharge]] — is for a customer who
 * accepted the flavor but was billed above the grandfathered rate).
 *
 * This module is the pure classifier + plan builder. It NEVER mutates state and
 * NEVER calls [[./refund]] `issueRefund` — the caller (Sol's first-touch box
 * session in later phases) executes the refund with the plan returned here.
 *
 * Classifications:
 *
 *   - `crisis_swap_rejected` — active crisis on the affected product AND the
 *     order line-items include the default_swap variant AND the customer's
 *     message carries a rejection signal → plan is a FULL refund of the
 *     remaining balance.
 *
 *   - `swap_accepted` — active crisis + swap on the order, but the customer's
 *     message accepts the substitute OR asks for a different in-stock flavor →
 *     NOT flagged for a full refund.
 *
 *   - `overcharge_only` — no active crisis / order does not carry the swap
 *     variant. Any refund needed here is the sibling price-correction partial
 *     ([[../subscription-overcharge]]), NEVER a full refund.
 *
 *   - `no_match` — none of the above.
 */

/** An active crisis on the customer — normalized shape the classifier consumes. */
export interface CrisisSwapRejectedCrisisInput {
  id: string;
  status: string | null;
  affected_variant_id: string | null;
  default_swap_variant_id: string | null;
}

/** A renewal order — normalized shape the classifier consumes. */
export interface CrisisSwapRejectedOrderInput {
  id: string;
  order_number: string | null;
  total_cents: number;
  /** Sum of any prior refunds against this order (cents). */
  prior_refunded_cents?: number;
  line_items: Array<{ variant_id?: string | number | null; title?: string | null }>;
}

/** Customer message input — the free text Sol reasons over. */
export interface CrisisSwapRejectedMessageInput {
  /** The customer's most recent inbound message text. */
  text: string;
}

export interface CrisisSwapRejectedInput {
  crisis: CrisisSwapRejectedCrisisInput | null;
  order: CrisisSwapRejectedOrderInput | null;
  message: CrisisSwapRejectedMessageInput | null;
}

export type CrisisSwapClassification =
  | "crisis_swap_rejected"
  | "swap_accepted"
  | "overcharge_only"
  | "no_match";

export interface CrisisSwapRefundPlan {
  order_id: string;
  order_number: string | null;
  /** cents — the full remaining balance to refund (order_total − prior refunds). */
  amount_cents: number;
  reason: string;
}

export interface CrisisSwapRejectedResult {
  classification: CrisisSwapClassification;
  /** Present only when classification === 'crisis_swap_rejected'. */
  refund_plan?: CrisisSwapRefundPlan;
  /** Human-legible one-liner citing the concrete cues so a downstream reviewer
   *  can see WHY the classifier picked this branch (audit / internal-note fodder). */
  reason: string;
}

/** Rejection keywords — the customer signals they will NOT accept the substitute. */
const REJECTION_PATTERNS: RegExp[] = [
  /\bberry[\s-]?only\b/i,
  /\bno\s+substitut(ions?|es?)\b/i,
  /\bdo\s?n[o']?t\s+substitute\b/i,
  /\bdon[o']?t\s+want\s+(the\s+)?(substitute|swap|replacement)\b/i,
  /\bdo\s?n[o']?t\s+want\s+the\s+(different\s+)?flavor\b/i,
  /\breject(ing)?\s+the\s+(substitute|swap|replacement)\b/i,
  /\bi[’']?ll\s+wait\b/i,
  /\bi\s+will\s+wait\b/i,
  /\bwait\s+(for|until)\s+(the\s+)?(mixed\s+)?berry\b/i,
  /\bcan[’']?t\s+use\s+(the\s+)?(substitute|swap|replacement|different\s+flavor)\b/i,
  /\bonly\s+want(ed)?\s+(the\s+)?(mixed\s+)?berry\b/i,
];

/** Acceptance keywords — the customer OKs the substitute or asks for a different in-stock flavor. */
const ACCEPTANCE_PATTERNS: RegExp[] = [
  /\b(that|the\s+swap|the\s+substitute)\s+is\s+fine\b/i,
  /\bfine\s+with\s+(the\s+)?(swap|substitute|replacement)\b/i,
  /\bok(ay)?\s+with\s+(the\s+)?(swap|substitute|replacement)\b/i,
  /\bhappy\s+to\s+(try|take)\s+(the\s+)?(swap|substitute)\b/i,
  /\bkeep\s+(the\s+)?(swap|current)\b/i,
  /\bcan\s+i\s+(get|try|have)\s+.*\s+instead\b/i,
  /\bcan\s+you\s+(send|swap)\s+.*\s+instead\b/i,
];

/**
 * Detect a rejection signal in the customer's free-text message. Pure. Returns
 * `true` when at least one rejection pattern matches AND no acceptance pattern
 * matches — a message that reads "the swap is fine but I'd love mixed berry
 * back soon" is NOT a rejection.
 */
export function detectSwapRejectionSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = String(text);
  const rejects = REJECTION_PATTERNS.some((p) => p.test(t));
  if (!rejects) return false;
  const accepts = ACCEPTANCE_PATTERNS.some((p) => p.test(t));
  return !accepts;
}

/**
 * Detect an acceptance signal — the customer OKs the substitute or is asking
 * for a different IN-STOCK flavor. Returns `true` only when at least one
 * acceptance pattern matches and no rejection pattern does.
 */
export function detectSwapAcceptanceSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = String(text);
  const accepts = ACCEPTANCE_PATTERNS.some((p) => p.test(t));
  if (!accepts) return false;
  const rejects = REJECTION_PATTERNS.some((p) => p.test(t));
  return !rejects;
}

/** True when the order's line items include the crisis's `default_swap_variant_id`. */
function orderCarriesSwap(
  order: CrisisSwapRejectedOrderInput,
  swapVariantId: string,
): boolean {
  if (!swapVariantId) return false;
  return (order.line_items || []).some(
    (li) => String(li.variant_id ?? "") === swapVariantId,
  );
}

/**
 * Classify one (crisis, order, message) triple into one of four buckets and,
 * when the bucket is `crisis_swap_rejected`, build the full-refund plan
 * (order_total − prior refunds, clamped to zero). Pure.
 *
 * The classifier NEVER emits a full refund for a `swap_accepted` message or for
 * an order that does not carry the swap variant. When the crisis is not active
 * or the customer has no active crisis at all, the result is `overcharge_only`
 * — the caller must fall back to the sibling price-correction path
 * ([[../subscription-overcharge]]), which is a partial refund of the delta, not
 * a full refund.
 */
export function classifyCrisisSwap(
  input: CrisisSwapRejectedInput,
): CrisisSwapRejectedResult {
  const { crisis, order, message } = input;

  if (!crisis || crisis.status !== "active" || !crisis.default_swap_variant_id) {
    return {
      classification: "overcharge_only",
      reason:
        "no active crisis with a default_swap — a refund need here is a price-correction partial, not a full refund",
    };
  }
  if (!order) {
    return { classification: "no_match", reason: "no order in scope" };
  }
  if (!orderCarriesSwap(order, crisis.default_swap_variant_id)) {
    return {
      classification: "overcharge_only",
      reason: `order ${order.order_number ?? order.id} does not carry the default_swap variant — a refund here is a price-correction partial`,
    };
  }

  const text = message?.text ?? "";
  const rejected = detectSwapRejectionSignal(text);
  const accepted = detectSwapAcceptanceSignal(text);

  if (accepted && !rejected) {
    return {
      classification: "swap_accepted",
      reason:
        "customer signaled acceptance of the substitute (or asked for a different in-stock flavor) — do NOT full-refund",
    };
  }
  if (!rejected) {
    return {
      classification: "no_match",
      reason:
        "no rejection signal in the customer's message — do not classify as crisis-swap-rejected",
    };
  }

  const prior = Math.max(0, order.prior_refunded_cents ?? 0);
  const remaining = Math.max(0, (order.total_cents || 0) - prior);
  return {
    classification: "crisis_swap_rejected",
    refund_plan: {
      order_id: order.id,
      order_number: order.order_number,
      amount_cents: remaining,
      reason: `crisis-swap-rejected: full remaining-balance refund on order ${order.order_number ?? order.id} (customer rejected the ${crisis.default_swap_variant_id} substitute)`,
    },
    reason:
      "active crisis + order carries default_swap variant + customer message carries a rejection signal → full remaining-balance refund",
  };
}
