/**
 * Pre-send validator for a drafted review-request message — the deterministic
 * hard-block sibling of the predeploy `scripts/_check-*.ts` rails, but at
 * runtime (docs/brain/specs/review-request-sol-session Phase 2).
 *
 * A drafted message CANNOT send if ANY of these hard rules trip. The whole
 * program's value is in the message; the failure that would actually kill it
 * is not mediocre prose but a broken merge field telling a two-year customer
 * they have been with us for 0 days. This validator is the absolute half:
 * things that can never be wrong, checked by code, no LLM taste involved.
 *
 * Hard rules (per the spec's Phase 2 § "The validator (deterministic,
 * hard-block)"):
 *
 *   • any `{{ }}` mustache token survives into the body (unfilled merge);
 *   • the hand-picked fact is degenerate (0 days, or a loyalty claim on a
 *     first order);
 *   • the product named is not the product being asked about;
 *   • the pretext is not from the approved set (a fabricated angle);
 *   • SMS exceeds 160 GSM-7 including the shortlink, or is missing STOP;
 *   • the coupon framing is conditional on sentiment;
 *   • there is more than one ask in the message.
 *
 * Phase 1 lands the exported chokepoint + the small handful of rules that are
 * absolute AND cheap to check without any downstream shape (unfilled mustache
 * tokens, empty body, more-than-one-ask). Phase 2 fleshes the rest of the
 * rules in — the tenure / merge-field / SMS-GSM-7 / STOP / approved-pretext
 * / sentiment-coupon checks all layer on top of the same chokepoint. Callers
 * (the Phase-3 send path) route every drafted message through
 * `validateReviewRequest` before it hands off to `deliverPendingSends`; a
 * BLOCK verdict short-circuits the send.
 *
 * Kept as a PURE function so the invariant is reviewable + unit-testable in
 * isolation without a DB, mirroring the triage-escalations selection
 * predicates and the sol-policy-bait-guard shape.
 */

/**
 * The channels this validator supports. Text so the ladder can add new
 * channels (mini-site, in-app, ...) without a migration; readers switch on
 * the value they know.
 */
export type ReviewRequestChannel = "email" | "sms";

/**
 * A drafted review-request message the sender is about to hand to
 * deliverPendingSends. `body` is the customer-facing text; `subject` is the
 * email subject line (empty for SMS). `channel` narrows which channel-
 * specific rules run (SMS carries an added length + STOP-suffix rail).
 *
 * Phase 2 will extend this shape with the merge-field context (tenure_days,
 * product_id, angle, coupon_code) so the tenure-degenerate + wrong-product
 * + sentiment-conditional-coupon rails have the raw inputs they need. Phase
 * 1 keeps the shape minimal so the chokepoint compiles before Phase 2
 * adds those fields.
 */
export interface ReviewRequestDraft {
  channel: ReviewRequestChannel;
  subject: string;
  body: string;
}

/**
 * The verdict `validateReviewRequest` returns. On a BLOCK, the caller MUST
 * NOT send; the `reasons` array names every rail that tripped so the send
 * path can surface a diagnosable failure to CS + a subsequent regenerate
 * pass has concrete direction. An empty reasons array = allowed to send.
 */
export interface ReviewRequestValidationVerdict {
  allow: boolean;
  reasons: string[];
}

/** Regex matching an unfilled mustache token — `{{ ... }}` with any content. */
const MUSTACHE_TOKEN = /\{\{[^}]*\}\}/;

/**
 * A rough heuristic for "more than one ask" — a body carrying more than one
 * literal question mark. A drafted review request asks ONE question: the
 * ask. Two question marks means the draft is stacking asks (or asking a
 * rhetorical question alongside the ask); either way, a human should look at
 * it before it sends. Kept intentionally cheap — the rule is a floor, not a
 * ceiling; Phase 2 layers on top of it.
 */
function countLiteralQuestions(body: string): number {
  return (body.match(/\?/g) || []).length;
}

/**
 * The deterministic pre-send validator. Runs every rail that's absolute on
 * the drafted message and returns a verdict. NEVER throws — a
 * malformed/missing field falls through as a BLOCK with a named reason so
 * the caller can surface a diagnosable failure rather than an opaque
 * exception at the send boundary.
 */
export function validateReviewRequest(
  draft: ReviewRequestDraft,
): ReviewRequestValidationVerdict {
  const reasons: string[] = [];

  const body = typeof draft.body === "string" ? draft.body : "";
  const subject = typeof draft.subject === "string" ? draft.subject : "";
  const channel: ReviewRequestChannel =
    draft.channel === "sms" ? "sms" : "email";

  // Rule: empty / whitespace-only body — a drafted ask with nothing in it is
  // never a valid customer message. Same shape the sol-policy-bait-guard
  // uses for a missing reply.
  if (!body.trim()) {
    reasons.push("empty_body");
  }

  // Rule: an unfilled `{{ ... }}` mustache token survived into the body OR
  // subject. This is the "0 days" failure the spec calls out — a broken
  // merge field telling a two-year customer they have been with us for 0
  // days is worse than a mediocre message, and it is entirely mechanical
  // to detect. Applies to the subject too because a subject line with an
  // unfilled tag is the FIRST thing the customer sees.
  if (MUSTACHE_TOKEN.test(body)) {
    reasons.push("unfilled_mustache_in_body");
  }
  if (MUSTACHE_TOKEN.test(subject)) {
    reasons.push("unfilled_mustache_in_subject");
  }

  // Rule: more than one ask. A drafted review request asks ONE question.
  // Two literal question marks means the draft is stacking asks or wedging
  // a rhetorical question alongside the ask; either way, a human should
  // look at it before it sends. Cheap floor — Phase 2 layers a semantic
  // "multiple-asks" rail on top.
  if (countLiteralQuestions(body) > 1) {
    reasons.push("more_than_one_ask");
  }

  // Rule: SMS-shape rails — the 160 GSM-7 length ceiling and the required
  // STOP suffix. Phase 1 lands the length rail (character-count with
  // shortlink included is what the sender already computes); the semantic
  // STOP-word suffix is layered in Phase 2 alongside the coupon-framing
  // rail (both live at the message-composition layer that Phase 2
  // introduces). The length rail is safe to enforce now because the sender
  // already has the composed body length in hand.
  if (channel === "sms" && body.length > 160) {
    reasons.push("sms_body_over_160_chars");
  }

  return { allow: reasons.length === 0, reasons };
}
