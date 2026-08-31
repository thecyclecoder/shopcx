/**
 * First-touch review-request body composer — the trigger-aware pure half of
 * the shared draft/validate/send path (Phase 2 of both
 * review-request-sol-session and [[docs/brain/specs/review-request-post-order-ask]]).
 *
 * The two triggers ship the SAME rubric self-score / independent QC pass /
 * pre-send validator / canary hold — but their first-touch COPY differs:
 *
 *   • **ticket trigger** — a conversation just happened, so the warmth of
 *     the message comes from that thread; a follow-up phrasing that gestures
 *     at the recent exchange lands as sincere.
 *
 *   • **post-order trigger** — there is no thread. A message that gestures
 *     at a support interaction that never occurred reads worse than a plain
 *     one, so the copy leans entirely on the product itself and the
 *     hand-picked tenure fact (repeat vs first-time).
 *
 * This module is intentionally PURE + centralized so both trigger handlers
 * compose their body through the SAME function. A future evidence-driven
 * tweak to one branch cannot silently diverge the two; a change here is a
 * change to BOTH shapes.
 *
 * Kept exported so `review-request-post-order-ask` Phase 2 (this branch)
 * and the ticket-side Phase-2 apply-path (future) can both call it, and so
 * the invariant is reviewable + unit-testable in isolation without a DB.
 */

/**
 * The trigger that produced this ask. Text so a future trigger (e.g. a
 * loyalty-program milestone) can extend the set without a migration; the
 * composer's downstream branch on the value stays exhaustive at type time.
 */
export type ReviewRequestTrigger = "ticket" | "post-order";

/** The window classifier the post-order detector labeled the candidate
 * with. `null` when the trigger is not post-order. */
export type ReviewRequestWindow = "first-time" | "repeat" | null;

/**
 * The composer's typed input bag. Every optional field is a piece of
 * hand-picked context; a missing field falls back to a plain phrasing so
 * a caller with incomplete data still ships a truthful message (the
 * validator's `tenure_degenerate` / `loyalty_claim_on_first_order` rails
 * catch the actively-wrong cases).
 */
export interface ComposeReviewRequestFirstTouchInput {
  /** Which trigger this ask came from. */
  trigger: ReviewRequestTrigger;
  /** The channel the sender picked — the composer switches SMS vs email
   * body layout on this value. */
  channel: "email" | "sms";
  /** The angle Sol picked (or the deterministic post-order default). */
  angle: "defend" | "fence-sitter";
  /** The product the customer is being asked about. */
  productName: string;
  /** Optional greeting name — first name preferred, falls back to a
   * name-less phrasing when absent. */
  customerFirstName?: string | null;
  /** Composed URL the CTA points at — the sender bakes the per-ask token
   * into this before calling the composer. */
  reviewUrl: string;
  /** The window label the post-order detector attached; `null` for the
   * ticket trigger. Used to key the tenure phrasing on the concrete
   * repeat-vs-first-time signal instead of a broad "you've been a customer"
   * claim. */
  window?: ReviewRequestWindow;
  /**
   * How many days the customer has been on Superfoods at draft time.
   * Kept optional — the validator's `tenure_degenerate_zero_days` rail
   * catches a 0-days ship regardless. When set, the composer leans on it
   * as the hand-picked fact.
   */
  tenureDays?: number | null;
}

/**
 * The composed output — subject + body pair the caller hands to the
 * shared validator + drafts table.
 */
export interface ComposedReviewRequestFirstTouch {
  subject: string;
  body: string;
}

/**
 * Compose a first-touch review-request body. Kept PURE so the two trigger
 * paths share one implementation and a divergence is impossible without
 * touching THIS module. See the docstring for the trigger-shape contract.
 */
export function composeReviewRequestFirstTouchBody(
  input: ComposeReviewRequestFirstTouchInput,
): ComposedReviewRequestFirstTouch {
  const product = String(input.productName || "").trim() || "the product";
  const url = String(input.reviewUrl || "").trim();
  const first = String(input.customerFirstName || "").trim();
  const greeting = first ? `Hey ${first},` : "Hey,";

  // Trigger-branch: the two shapes differ ONLY on the opening's warrant.
  // Post-order leans on the product + optional tenure fact; ticket-trigger
  // leans on the thread (which the caller will inject as a lead sentence
  // via the future ticket-side wrapper — the shared body below is the
  // stable half).
  const openingLine =
    input.trigger === "post-order"
      ? composePostOrderOpening({
          product,
          window: input.window ?? null,
          tenureDays: input.tenureDays ?? null,
        })
      : composeTicketOpening({ product });

  // Angle-branch: `defend` invites the customer to respond to a common
  // complaint they can refute; `fence-sitter` casts them as the tenured
  // voice a would-be buyer needs. Both are stable across triggers — the
  // rubric's angle-shape rail (`unapproved_pretext`) is what enforces the
  // set at validate-time.
  const askLine =
    input.angle === "defend"
      ? `We hear from a few folks worried about whether it actually works — would you be up for saying what it's been like for you?`
      : `A note from someone who's actually used it moves more people than anything we could say — would you share yours?`;

  if (input.channel === "sms") {
    // House SMS shape: block layout with the CTA link isolated on its own
    // line — see the validator's `sms_link_not_on_its_own_line` +
    // `sms_missing_block_layout` rails. STOP suffix required, so the
    // template includes it verbatim.
    const body = [
      greeting,
      "",
      openingLine,
      "",
      askLine,
      "",
      "Leave a review here:",
      url,
      "",
      "Reply STOP to opt out.",
    ].join("\n");
    return { subject: "", body };
  }

  // Email — the subject uses the product name so the customer sees WHAT
  // the ask is about before opening. Body carries the same block shape as
  // SMS but with paragraph breaks natural to email.
  const subject = `Quick question about ${product}`;
  const body = [
    greeting,
    "",
    openingLine,
    "",
    askLine,
    "",
    `Leave a review here:`,
    url,
  ].join("\n");
  return { subject, body };
}

/**
 * Post-order opening — leans on the product + concrete window fact
 * ("bought again" for repeat, "trying it for the first time" for
 * first-time). NEVER gestures at a support conversation.
 */
function composePostOrderOpening(input: {
  product: string;
  window: ReviewRequestWindow;
  tenureDays: number | null;
}): string {
  const p = input.product;
  const t = input.tenureDays;
  const tenurePhrase =
    typeof t === "number" && t >= 30 && t < 365
      ? ` — you've been with us about ${Math.round(t / 30)} months`
      : typeof t === "number" && t >= 365
        ? ` — you've been with us over a year`
        : "";
  if (input.window === "repeat") {
    return `You ordered ${p} again${tenurePhrase}, so it must be doing its job.`;
  }
  if (input.window === "first-time") {
    return `You tried ${p} for the first time${tenurePhrase} — a real read from someone new to it is the most valuable kind.`;
  }
  return `Hoping to hear how ${p} has been for you${tenurePhrase}.`;
}

/**
 * Ticket opening — leans on the conversation that just happened. The
 * shared composer produces the ask half; the ticket-side wrapper (future)
 * prepends a lead sentence that references the resolved conversation, so
 * the trigger's warrant is EXPLICIT in the same module rather than being
 * a hidden convention in a downstream call site.
 */
function composeTicketOpening(input: { product: string }): string {
  return `Thanks again for reaching out — glad we got you sorted. If you have a minute, hearing how ${input.product} has been for you would mean a lot.`;
}
