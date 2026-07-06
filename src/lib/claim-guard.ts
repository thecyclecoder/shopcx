/**
 * Claim↔action binding guard — Phase 0 of the guaranteed-ticket-handling goal.
 *
 * Deterministic pre-send check: does an outbound message ASSERT that we already
 * performed an effect (refunded, cancelled, paused, applied a coupon, created a
 * return/order, swapped a variant, changed a date/address) that is NOT backed by
 * a verified action in this decision?
 *
 * This is the #1 broken-promise mechanism ("Category C" in the execution-
 * verification forensics): the model writes "I've refunded you" as prose while
 * emitting NO action, so nothing reaches the verifier and the false claim ships
 * unchecked. Roughly half of all broken_action/false_promise grader issues are
 * this shape.
 *
 * The guard is intentionally CONSERVATIVE — it only trips on first-person /
 * passive COMPLETED assertions ("I've refunded", "your subscription has been
 * cancelled"), never on offers ("I can refund you"), questions ("would you like
 * me to cancel?"), future intent ("I'll process that"), or descriptions of the
 * CUSTOMER's own action ("you cancelled your subscription"). Pure + deterministic
 * (no I/O, no model). Fail-safe: callers ESCALATE on a hit rather than send.
 */

export interface EffectPattern {
  /** short label for the escalation reason */
  effect: string;
  /** action families (SonnetDecision action `type`s) that would legitimately back this claim */
  families: string[];
  re: RegExp;
}

// Each pattern requires a "WE did it, and it's done" framing:
//   `I/we ('ve| have) [filler] <verb> <object>`  OR  `your <noun> has been <verb>`.
// LEAD absorbs the common fillers ("gone ahead and", "just", "already", "now")
// so they don't defeat the match. The object is pinned to the effect noun so
// generic verbs ("processed", "changed", "added") can't trip on unrelated text.
const LEAD = String.raw`(?:i|we)(?:'ve|\s+have)\s+(?:(?:gone ahead and|just|already|also|now)\s+)*`;
const P = (body: string) => new RegExp(body, "i");

export const EFFECT_PATTERNS: EffectPattern[] = [
  {
    effect: "refund",
    families: ["partial_refund", "redeem_points_as_refund"],
    re: P(String.raw`\b${LEAD}(?:refunded\s+(?:you|your|\$)|issued\s+(?:a\s+|your\s+|the\s+|you\s+a\s+)?refund|processed\s+(?:a\s+|your\s+|the\s+)?refund)\b|\byour\s+refund\s+(?:has been|is|was)\s+(?:processed|issued|completed)\b`),
  },
  {
    effect: "cancel",
    families: ["cancel"],
    re: P(String.raw`\b${LEAD}cancel(?:l?ed)\s+(?:your\s+)?(?:subscription|order|plan)\b|\byour\s+(?:subscription|order|plan)\s+(?:has been|is now|was)\s+cancel(?:l?ed)\b`),
  },
  {
    effect: "pause",
    families: ["pause", "pause_timed", "crisis_pause"],
    re: P(String.raw`\b${LEAD}paused\s+(?:your\s+)?(?:subscription|order|plan|next)\b|\byour\s+subscription\s+(?:has been|is now|was)\s+paused\b`),
  },
  {
    effect: "coupon",
    families: ["apply_coupon", "apply_loyalty_coupon"],
    re: P(String.raw`\b${LEAD}(?:applied|added)\s+(?:a\s+|the\s+|your\s+)?(?:\$?\d+%?\s+)?(?:coupon|discount|credit)\b|\b(?:coupon|discount|credit)\s+(?:has been|is now)\s+applied\b`),
  },
  {
    effect: "return",
    families: ["create_return"],
    re: P(String.raw`\b${LEAD}(?:created|generated|started|set up)\s+(?:a\s+|your\s+)?return\b|\byour\s+return\s+(?:has been|is)\s+(?:created|started|set up)\b`),
  },
  {
    effect: "order",
    families: ["create_replacement_order"],
    re: P(String.raw`\b${LEAD}(?:placed|created)\s+(?:a\s+|your\s+)?(?:replacement\s+|new\s+)?order\b|\byour\s+(?:replacement|new)\s+order\s+(?:has been|is|was)\s+(?:placed|created)\b`),
  },
  {
    effect: "swap",
    families: ["swap_variant"],
    re: P(String.raw`\b${LEAD}(?:swapped|switched|changed)\s+(?:your\s+)?(?:flavor|variant|item|product)\b`),
  },
  {
    effect: "date",
    families: ["change_next_date"],
    re: P(String.raw`\b${LEAD}(?:changed|updated|moved|pushed back|rescheduled)\s+(?:your\s+)?(?:next\s+)?(?:order|delivery|billing|charge|shipment)\s+date\b|\byour\s+(?:next\s+)?(?:order|delivery|billing)\s+date\s+(?:has been|is now|was)\s+(?:changed|updated|moved)\b`),
  },
  {
    effect: "address",
    families: ["update_shipping_address"],
    re: P(String.raw`\b${LEAD}updated\s+(?:your\s+)?(?:shipping\s+)?address\b|\byour\s+(?:shipping\s+)?address\s+(?:has been|is now|was)\s+updated\b`),
  },
];

/**
 * Returns the effect the message CLAIMS as done-but-unbacked, or null if the
 * message asserts nothing actionable (or every asserted effect is backed by a
 * verified action family present in `backed`).
 *
 * @param message  the outbound customer-facing text
 * @param backed   action families that actually ran + verified in this decision
 *                 (pass an EMPTY set for paths that attach no actions — e.g.
 *                 ai_response/kb_response — where any completed-effect claim is
 *                 by definition unbacked)
 */
export function unbackedEffectClaim(
  message: string | null | undefined,
  backed: Set<string>,
): string | null {
  if (!message) return null;
  for (const p of EFFECT_PATTERNS) {
    if (p.re.test(message) && !p.families.some((f) => backed.has(f))) return p.effect;
  }
  return null;
}
