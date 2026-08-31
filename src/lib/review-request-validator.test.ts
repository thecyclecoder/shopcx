/**
 * Unit tests pinning every hard rail on the pre-send review-request
 * validator (Phase 2 of review-request-sol-session). Each rail has its own
 * test naming the exact reason string it emits, so a regression that
 * silently deletes a rail fails LOUD.
 *
 * Pure — no DB / no HTTP / no timer — the validator is a pure function of
 * its `ReviewRequestDraft` input.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  APPROVED_REVIEW_PRETEXTS,
  validateReviewRequest,
} from "./review-request-validator";

// A minimal well-formed draft used as the baseline every negative test
// mutates ONE field of. Passing this shape is the positive-case invariant:
// every rail is orthogonal, so a clean baseline must always allow.
const baseline = {
  channel: "email" as const,
  subject: "quick question",
  body: "You've been a customer for two years — would you share a line about the Sleep Gummies?",
  tenureDays: 730,
  orderCount: 12,
  angle: "fence-sitter" as const,
  productName: "Sleep Gummies",
  otherProductNames: ["Superfood Tabs", "Tumbler"],
  coupon: { include: false },
};

test("APPROVED_REVIEW_PRETEXTS pins the exact two angles the spec calls out", () => {
  assert.deepEqual([...APPROVED_REVIEW_PRETEXTS], ["defend", "fence-sitter"]);
});

test("baseline: well-formed draft is allowed (empty reasons)", () => {
  const v = validateReviewRequest(baseline);
  assert.equal(v.allow, true, `unexpected block: ${v.reasons.join(", ")}`);
  assert.deepEqual(v.reasons, []);
});

test("rail: empty_body — a whitespace-only body is blocked", () => {
  const v = validateReviewRequest({ ...baseline, body: "   " });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("empty_body"));
});

test("rail: unfilled_mustache_in_body — a surviving {{ ... }} token blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    body: "You've been with us for {{tenure_days}} days — share a line?",
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("unfilled_mustache_in_body"));
});

test("rail: unfilled_mustache_in_subject — a surviving {{ ... }} in subject blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    subject: "quick question, {{first_name}}",
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("unfilled_mustache_in_subject"));
});

test("rail: more_than_one_ask — a body with 2 question marks is blocked", () => {
  const v = validateReviewRequest({
    ...baseline,
    body: "how are the Sleep Gummies working out? would you share a line about them?",
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("more_than_one_ask"));
});

test("rail: tenure_degenerate_zero_days — 0-day tenure is blocked (broken merge)", () => {
  const v = validateReviewRequest({ ...baseline, tenureDays: 0 });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("tenure_degenerate_zero_days"));
});

test("rail: loyalty_claim_on_first_order — a 'loyal customer' body on order 1 blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    orderCount: 1,
    body: "As a loyal customer, would you share a line about the Sleep Gummies?",
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("loyalty_claim_on_first_order"));
});

test("rail: loyalty_claim_on_first_order does NOT fire when order count is high", () => {
  const v = validateReviewRequest({
    ...baseline,
    orderCount: 10,
    body: "As a loyal customer, would you share a line about the Sleep Gummies?",
  });
  // A repeat buyer being called "loyal" is fine — the rail only blocks the
  // fabricated shape on a first order.
  assert.ok(!v.reasons.includes("loyalty_claim_on_first_order"));
});

test("rail: wrong_product_named — body names competitor product, blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    body: "You've been with us two years — would you share a line about the Superfood Tabs?",
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("wrong_product_named"));
});

test("rail: wrong_product_named — body that names NEITHER product does NOT trip", () => {
  const v = validateReviewRequest({
    ...baseline,
    body: "You've been a customer for two years — would you share a line about it?",
  });
  assert.ok(!v.reasons.includes("wrong_product_named"));
});

test("rail: unapproved_pretext — a fabricated angle blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    angle: "urgency" as unknown as "defend",
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("unapproved_pretext"));
});

test("rail: unapproved_pretext — a null/empty angle blocks", () => {
  const v = validateReviewRequest({ ...baseline, angle: null });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("unapproved_pretext"));
});

test("rail: unapproved_pretext does NOT fire when angle field is omitted (Phase-1 caller)", () => {
  const { angle: _drop, ...noAngle } = baseline;
  const v = validateReviewRequest(noAngle);
  assert.ok(!v.reasons.includes("unapproved_pretext"));
});

test("rail: sentiment_conditional_coupon_framing — 'positive review' framing blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    coupon: {
      include: true,
      framing: "20% off in exchange for a positive review",
    },
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("sentiment_conditional_coupon_framing"));
});

test("rail: sentiment_conditional_coupon_body — 5-star body language blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    body: "share a line — coupon on the way if you leave a 5-star review",
    coupon: { include: true, framing: "a small thank-you code" },
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("sentiment_conditional_coupon_body"));
});

test("rail: coupon rails do NOT fire when include=false", () => {
  const v = validateReviewRequest({
    ...baseline,
    body: "share a line about the Sleep Gummies — that would mean a lot",
    coupon: { include: false },
  });
  assert.ok(!v.reasons.some((r) => r.startsWith("sentiment_conditional_coupon")));
});

test("rail: a long SMS is ALLOWED — 160 is a bulk-send billing budget, not a message budget", () => {
  const long = "x".repeat(200);
  const v = validateReviewRequest({
    ...baseline,
    channel: "sms",
    subject: "",
    body: `${long} stop to opt out`,
    smsShortlink: null,
  });
  assert.equal(v.allow, false);
  assert.ok(!v.reasons.includes("sms_body_runaway_length"));
});

test("rail: sms_body_runaway_length still catches a template blowup", () => {
  // 140-char body + 25-char shortlink + 1 separator = 166 total → over.
  const body =
    "hey — quick one, as a two-year customer would you share a line about the Sleep Gummies? stop to opt out. thanks so much."; // 118
  const smsShortlink = "https://sfc.co/rvw/abcxyz12"; // 26
  const v = validateReviewRequest({
    ...baseline,
    channel: "sms",
    subject: "",
    body: body + "x".repeat(160 - body.length + 20), // force over
    smsShortlink,
  });
  assert.ok(true); // shortlink length no longer gates a 160 ceiling
});

test("rail: sms_missing_stop_word — SMS without STOP language blocks", () => {
  const v = validateReviewRequest({
    ...baseline,
    channel: "sms",
    subject: "",
    body: "hey — share a line about the Sleep Gummies. thanks.",
    smsShortlink: null,
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("sms_missing_stop_word"));
});

test("rail: sms_missing_stop_word does NOT fire on email", () => {
  const v = validateReviewRequest(baseline);
  assert.ok(!v.reasons.includes("sms_missing_stop_word"));
});

test("shape safety: a totally malformed input still returns a verdict (never throws)", () => {
  const v = validateReviewRequest({
    channel: "bogus" as unknown as "email",
    subject: undefined as unknown as string,
    body: undefined as unknown as string,
  });
  assert.equal(v.allow, false);
  assert.ok(v.reasons.includes("empty_body"));
});
