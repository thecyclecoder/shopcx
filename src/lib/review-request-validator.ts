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
 *   • the pretext (angle) is not from the approved set (a fabricated angle);
 *   • SMS exceeds 160 GSM-7 including the shortlink, or is missing STOP;
 *   • the coupon framing is conditional on sentiment;
 *   • there is more than one ask in the message.
 *
 * Every rail is checked HERE at the Phase-2 chokepoint every drafted message
 * routes through. Callers (the Phase-3 send path) route every drafted
 * message through `validateReviewRequest` before it hands off to
 * `deliverPendingSends`; a BLOCK verdict short-circuits the send AND is
 * persisted to `review_message_drafts.validator_verdict` so a later grader
 * sweep can correlate why a draft died.
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
 * The pretext (angle) set the spec pins for a review request. Sol picks
 * ONE per customer:
 *   • 'defend'       — a real detractor's claim; the customer is invited to
 *                       answer it.
 *   • 'fence-sitter' — a real support-ticket question; the customer's tenure
 *                       is the credential.
 * A draft carrying an angle outside this set is a fabricated pretext and the
 * validator hard-blocks it — see the `unapproved_pretext` rail.
 */
export const APPROVED_REVIEW_PRETEXTS = ["defend", "fence-sitter"] as const;
export type ReviewRequestPretext = (typeof APPROVED_REVIEW_PRETEXTS)[number];

/**
 * A drafted review-request message the sender is about to hand to
 * deliverPendingSends. `body` is the customer-facing text; `subject` is the
 * email subject line (empty for SMS). `channel` narrows which channel-
 * specific rules run (SMS carries an added length + STOP-suffix rail).
 *
 * Phase 2 adds the merge-field context (`tenureDays`, `orderCount`, the
 * product being asked about, `angle`, coupon shape) so the tenure-degenerate
 * + wrong-product + sentiment-conditional-coupon rails have the raw inputs
 * they need. Every added field is OPTIONAL so the Phase-1 minimal-shape
 * callers keep compiling; a missing field skips the rail that needs it (a
 * conservative default — the caller can pass more context to enforce more
 * rails).
 */
export interface ReviewRequestDraft {
  channel: ReviewRequestChannel;
  subject: string;
  body: string;
  /**
   * Tenure of the customer in whole days at draft time. Used by the
   * `tenure_degenerate` rail — a message that ships to a 0-day customer with
   * a "you've been with us..." fact is exactly the broken-merge failure the
   * spec calls out.
   */
  tenureDays?: number | null;
  /**
   * Lifetime order count (delivered, not just placed) at draft time. Used by
   * the `loyalty_claim_on_first_order` rail — a "loyal customer" or
   * "long-time customer" claim on a first order is a fabricated fact.
   */
  orderCount?: number | null;
  /**
   * The angle (pretext) Sol picked for this draft — MUST be in
   * `APPROVED_REVIEW_PRETEXTS`. A missing/other value trips
   * `unapproved_pretext`.
   */
  angle?: string | null;
  /**
   * The product being asked about — display name expected to appear in the
   * body. Used by the `wrong_product` rail: if `productName` is set but the
   * body names a DIFFERENT product from `otherProductNames`, the draft is
   * asking about product A while naming product B — a bait.
   */
  productName?: string | null;
  /**
   * Other product display names in the workspace's catalog the body might
   * accidentally match. Used with `productName` to detect a wrong-product
   * mention. Pass the recent-orders product names — that is the pool a
   * hand-picked fact would confuse.
   */
  otherProductNames?: string[];
  /**
   * The coupon shape carried alongside the draft. `include: false` means the
   * message never mentions a coupon; `include: true, framing` describes how
   * the message is FRAMING the coupon. The `sentiment_conditional_coupon`
   * rail hard-blocks a framing string that gates the coupon on a positive
   * review ("if you leave a good review", "for a 5-star review", etc.) —
   * illegal per the FTC review-solicitation guidance and, more importantly,
   * bait.
   */
  coupon?: {
    include: boolean;
    framing?: string | null;
  };
  /**
   * The composed shortlink URL used inside an SMS body. Passed in so the SMS
   * length rail sees the FULL as-sent length (body + shortlink), matching
   * the sender's composed shape. Ignored for email.
   */
  smsShortlink?: string | null;
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
 * SMS carrier-legal STOP-word set — a review-request SMS is close enough to
 * marketing that we ship the standard opt-out language. Case-insensitive
 * literal match against the composed body.
 */
const SMS_STOP_MARKERS: RegExp[] = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\btext stop\b/i,
  /\breply stop\b/i,
];

/**
 * Phrases that mark a coupon framing as CONDITIONAL on sentiment. Any of
 * these means the draft is baiting a positive-only review — illegal AND the
 * kind of thing that hurts the customer relationship long after the coupon
 * clears. Kept deliberately conservative — a marker match is a hard block,
 * so the phrases must be unambiguous. Sentiment-neutral framing like "as a
 * thank you" / "on the house" is fine and never trips this rail.
 */
const SENTIMENT_CONDITIONAL_COUPON_PATTERNS: RegExp[] = [
  /\bpositive review\b/i,
  /\bgood review\b/i,
  /\bgreat review\b/i,
  /\b5[- ]star\b/i,
  /\bfive[- ]star\b/i,
  /\bhonest review\b.*\bcoupon\b/i, // "in exchange for an honest review"-style
  /\bin exchange for\b.*\breview\b/i,
  /\bif you (leave|write|post) a\b.*\breview\b/i,
];

/**
 * Phrases that describe the customer as loyal / long-time / veteran. Used by
 * the `loyalty_claim_on_first_order` rail — a claim that requires tenure
 * but sits on a first-order account is fabricated.
 */
const LOYALTY_CLAIM_PATTERNS: RegExp[] = [
  /\bloyal customer\b/i,
  /\blong[- ]time customer\b/i,
  /\byears? with (us|superfoods)\b/i,
  /\bveteran customer\b/i,
];

/**
 * A rough heuristic for "more than one ask" — a body carrying more than one
 * literal question mark. A drafted review request asks ONE question: the
 * ask. Two question marks means the draft is stacking asks (or asking a
 * rhetorical question alongside the ask); either way, a human should look at
 * it before it sends.
 */
function countLiteralQuestions(body: string): number {
  return (body.match(/\?/g) || []).length;
}

/**
 * Case-insensitive whole-word match — used by the `wrong_product` rail to
 * check whether the body mentions a product from a set. Escapes regex
 * metacharacters in the product names so titles like "Sleep Gummies (12 ct)"
 * don't blow up.
 */
function bodyMentions(body: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return re.test(body);
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
  // look at it before it sends.
  if (countLiteralQuestions(body) > 1) {
    reasons.push("more_than_one_ask");
  }

  // Rule: tenure_degenerate — a claim that requires tenure sits on a
  // customer with (a) 0 days of tenure, or (b) a first order. Both shapes
  // are the failure the spec calls out ("0 days" merge, "loyalty claim on a
  // first order"). We check both signals independently so the reason list
  // names the specific rail that tripped.
  if (draft.tenureDays === 0) {
    reasons.push("tenure_degenerate_zero_days");
  }
  if (
    typeof draft.orderCount === "number" &&
    draft.orderCount <= 1 &&
    LOYALTY_CLAIM_PATTERNS.some((p) => p.test(body))
  ) {
    reasons.push("loyalty_claim_on_first_order");
  }

  // Rule: wrong_product — the body names a product that isn't the one being
  // asked about. Fires only when the caller passed `productName` (so a
  // Phase-1 minimal-shape caller doesn't trip it) AND the body actually
  // names a competing product from `otherProductNames`. A body that names
  // NEITHER product is fine — the ask can be about a product without
  // naming it directly (the CTA link resolves it).
  if (draft.productName) {
    const names = Array.isArray(draft.otherProductNames)
      ? draft.otherProductNames
      : [];
    const namesTheRightOne = bodyMentions(body, draft.productName);
    const wrongMention = names.some(
      (n) => n && n !== draft.productName && bodyMentions(body, n),
    );
    if (wrongMention && !namesTheRightOne) {
      reasons.push("wrong_product_named");
    }
  }

  // Rule: unapproved_pretext — the angle Sol picked must be in the pinned
  // approved set. A blank angle also trips this (a draft with no declared
  // angle is by definition a fabricated pretext). Only enforced when the
  // caller PASSED an angle field (a `null`/`undefined` means the caller
  // hasn't wired the field yet and the Phase-3 send path will).
  if (draft.angle !== undefined) {
    if (
      !draft.angle ||
      !(APPROVED_REVIEW_PRETEXTS as readonly string[]).includes(draft.angle)
    ) {
      reasons.push("unapproved_pretext");
    }
  }

  // Rule: sentiment_conditional_coupon — the coupon framing gates the code
  // on a POSITIVE review. Illegal per the FTC's review-solicitation guidance
  // AND bait; a hard block is the right response. Fires only when
  // `coupon.include=true` — a draft with no coupon can't trip this.
  if (draft.coupon?.include === true) {
    const framing = String(draft.coupon.framing ?? "");
    if (SENTIMENT_CONDITIONAL_COUPON_PATTERNS.some((p) => p.test(framing))) {
      reasons.push("sentiment_conditional_coupon_framing");
    }
    // Also check the body itself — a well-formed framing string paired with
    // a body that leaks the conditional language is the same failure.
    if (SENTIMENT_CONDITIONAL_COUPON_PATTERNS.some((p) => p.test(body))) {
      reasons.push("sentiment_conditional_coupon_body");
    }
  }

  // Rule: SMS-shape rails — the 160-char length ceiling and the required
  // STOP suffix. The composed length includes the shortlink because THAT is
  // what the carrier ships; a body under 160 that adds a 25-char shortlink
  // over the wire is over the ceiling.
  if (channel === "sms") {
    const shortlink = String(draft.smsShortlink ?? "");
    const composedLen = body.length + (shortlink ? shortlink.length + 1 : 0);
    if (composedLen > 160) {
      reasons.push("sms_body_over_160_chars");
    }
    if (!SMS_STOP_MARKERS.some((p) => p.test(body))) {
      reasons.push("sms_missing_stop_word");
    }
  }

  return { allow: reasons.length === 0, reasons };
}
