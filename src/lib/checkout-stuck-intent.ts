/**
 * checkout-stuck-intent — Phase 1 of
 * [[../../docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
 *
 * Pure classifier that recognizes a CHECKOUT-STUCK customer message as a first-class
 * intent, distinct from the coarse `account` bucket the [[unified-ticket-handler]]
 * classify-bucket step returns. A customer who "can't check out", whose OTP /
 * verification code isn't arriving, who is "stuck at the payment screen", asks
 * "how do I finish my order", OR who is BLOCKED PRE-PURCHASE on the storefront
 * itself (can't select a variant / can't choose a subscription tier / no option
 * to subscribe / can't add to cart) is a candidate for the assisted-purchase
 * concierge flow — not a stateless "try another card" dead-end reply and not a
 * cache-clear loop that invents UI to click through.
 *
 * Founder directive (2026-07-10): ANY checkout issue must default — as fast as
 * possible — to us CONCIERGING the purchase. Ticket aa0b6697 (Latrina C.) was
 * mis-classed `account`; her Shop Pay OTP never arrived and the orchestrator
 * told her to "try another card / PayPal / Shop Pay" instead of routing the
 * ticket back to Sol for an assisted-purchase Direction. Ticket 3dd271be
 * (mdengberg2, never subscribed, Mixed Berry 60-day sub) is the storefront-
 * block companion: the item was in stock (7,761 on hand; live PDP available)
 * but the orchestrator looped 3× on "clear your cache" and once invented a
 * "30/60/90 Day Supply card" UI that doesn't exist on the PDP; the customer
 * remained unable to buy while the ticket false-resolved 9/10. This predicate
 * is the *recognition* half of the fix; Phases 2-5 handle routing / Direction /
 * playbook / analytics.
 *
 * Shape mirrors [[inflection-detector]] — a rule catalog of specificity-ordered
 * regex cues, first match wins the evidence label. Pure function, no I/O; tests
 * pin every listed cue plus the aa0b6697 + 3dd271be fixtures and a negative
 * case for plain order-status / account questions.
 */

export interface CheckoutStuckClassification {
  /** True when at least one CUES entry matched. */
  matched: boolean;
  /** The winning cue id, e.g. `otp_not_arriving`. Only set when matched=true. */
  cue?: string;
  /** The verbatim reason string safe to stamp into an evidence field. */
  reason?: string;
}

/**
 * CUES — high-signal phrases seeded from the Phase 1 spec paragraph + real
 * customer language for the four categories:
 *   (a) "can't check out"
 *   (b) payment / OTP / verification code isn't arriving
 *   (c) "stuck at the payment or authentication screen"
 *   (d) "how do I finish my order"
 *
 * Ordered most-specific → most-general so a message that could match two entries
 * gets labeled with the tightest one. Every entry must be a phrase a customer
 * with a plain order-status / account question would NOT reasonably use — false
 * positives here reroute good tickets away from the ordinary account lane.
 */
const CUES: Array<{ id: string; re: RegExp }> = [
  // (b) OTP / verification code isn't arriving — Latrina's aa0b6697 case.
  {
    id: "otp_not_arriving",
    re: /\b(?:otp|verification|confirmation|security|shop\s*pay)\s*(?:code|text|message|sms)?\s*(?:did(?:n'?t| not)|has(?:n'?t| not)|hasn't|isn'?t|is not|won'?t|will not|never)\s*(?:arriv(?:e[ds]?|ing)|com(?:e[ds]?|ing)|show(?:ed|s|ing)?(?:\s+up)?|been sent|been delivered|been received)\b/i,
  },
  {
    id: "no_code_received",
    re: /\b(?:no|never (?:got|received)|didn'?t (?:get|receive))\s+(?:the\s+)?(?:otp|verification|confirmation|security|shop\s*pay)\s*(?:code|text|message|sms)\b/i,
  },
  // (c) stuck at the payment / authentication screen.
  {
    id: "stuck_at_payment_screen",
    re: /\bstuck\s+(?:at|on)\s+(?:the\s+)?(?:payment|checkout|authentication|shop\s*pay|otp|verification)(?:\s+(?:screen|page|step))?\b/i,
  },
  // (a) can't check out / can't complete the order.
  {
    id: "cant_check_out",
    re: /\b(?:can(?:'?t|not)|un(?:able|able\s+to))\s+(?:check\s*out|complete\s+(?:my\s+)?(?:order|checkout|purchase)|finish\s+(?:my\s+)?(?:order|checkout|purchase)|place\s+(?:my\s+)?order|pay\s+for\s+(?:my\s+)?order)\b/i,
  },
  {
    id: "checkout_not_working",
    re: /\b(?:checkout|check\s*out|payment|shop\s*pay)\s+(?:is(?:n'?t| not)|won'?t|will not|does(?:n'?t| not))\s+(?:work(?:ing)?|go(?:ing)? through|complet(?:e|ing)|process(?:ing)?|load(?:ing)?)\b/i,
  },
  // (d) "how do I finish my order?" — customer knows what they want, doesn't
  //     know how to get past the checkout screen. Distinct from an
  //     order-status question ("where is my order?").
  {
    id: "how_do_i_finish",
    re: /\bhow\s+(?:do|can|would|should)\s+i\s+(?:finish|complete|place|submit|pay\s+for)\s+(?:my\s+)?(?:order|purchase|checkout)\b/i,
  },
  // (e) Storefront pre-purchase block — customer cannot get an in-stock item
  //     INTO a purchase on the PDP itself (variant not selectable, no
  //     subscription tier option, add-to-cart not working). Ticket 3dd271be
  //     (Mixed Berry 60-day sub) — the failure this catches. Pivot to
  //     assisted purchase instead of a cache-clear loop or an invented UI
  //     description.
  {
    id: "no_subscribe_option",
    re: /\b(?:no|don'?t\s+(?:see|have)|there'?s\s+no|there\s+is\s+no|missing)\s+(?:an?\s+)?(?:option\s+(?:to|for)\s+)?(?:subscri(?:be|ption)|subscribe\s*(?:&|and)\s*save|s\s*&\s*s|(?:30|60|90)\s*(?:-|\s)?day)\b/i,
  },
  {
    id: "cant_select_variant",
    re: /\b(?:can(?:'?t|not)|un(?:able|able\s+to)|won'?t\s+let\s+me|will\s+not\s+let\s+me)\s+(?:select|choose|pick|click(?:\s+on)?)\s+(?:the\s+|a\s+|any\s+)?(?:(?:30|60|90)\s*(?:-|\s)?day|subscri(?:be|ption)|(?:flavou?r|variant|option|plan|tier|size))\b/i,
  },
  {
    id: "cant_add_to_cart",
    re: /\b(?:can(?:'?t|not)|un(?:able|able\s+to)|won'?t\s+let\s+me|will\s+not\s+let\s+me)\s+add\s+(?:it\s+|this\s+|them\s+|the\s+\w+\s+)?to\s+(?:my\s+|the\s+)?cart\b/i,
  },
];

/**
 * Classify an inbound customer message. Pure — safe to call anywhere, including
 * inside Inngest steps or the [[classify-bucket]] scheduler in
 * [[unified-ticket-handler]]. Returns `matched: false` for any message that
 * doesn't hit a cue — the coarse `account` / `general` / `outreach` bucket
 * still applies in that case.
 *
 * Normalization mirrors classifyIntent + inflection-detector: strip HTML tags,
 * decode entities enough for regex, collapse whitespace, trim. Case-insensitive
 * matching is baked into every cue regex.
 */
export function classifyCheckoutStuck(msg: string | null | undefined): CheckoutStuckClassification {
  if (!msg) return { matched: false };
  const clean = msg.replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return { matched: false };
  for (const cue of CUES) {
    if (cue.re.test(clean)) {
      return {
        matched: true,
        cue: cue.id,
        reason: `checkout-stuck: ${cue.id}`,
      };
    }
  }
  return { matched: false };
}

/**
 * Convenience: the coarse bucket label the router uses when the message is
 * checkout-stuck. Distinct from `account` / `general` / `outreach` — Phase 2
 * wires this into [[model-picker]] + the Sol re-session router.
 */
export const CHECKOUT_STUCK_BUCKET = "checkout-stuck" as const;
