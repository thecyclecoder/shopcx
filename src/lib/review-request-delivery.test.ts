/**
 * Unit tests pinning the pure half of the review-request delivery SDK
 * (Phase 3 of review-request-sol-session). Every predicate that gates the
 * nudge path is exercised here so a regression that quietly deletes a
 * suppression fails LOUD — a double-nudge would be a hard user-visible
 * regression.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  REVIEW_REQUEST_CANARY_HOLD_MS,
  REVIEW_REQUEST_NUDGE_DELAY_MS,
  REVIEW_REQUEST_OUTCOMES,
  isReviewRequestReadyForNudge,
  mintReviewRequestToken,
  pickReviewRequestChannel,
  shouldSuppressReviewRequestNudge,
} from "./review-request-delivery";
import { composeReviewRequestNudgeBody } from "./inngest/review-request-nudge-cron";
import {
  composeReviewCanaryDigestBody,
  reviewCanaryDigestDedupeKey,
} from "./inngest/review-request-canary-digest-cron";

test("REVIEW_REQUEST_OUTCOMES pins the exact lifecycle set the spec calls out", () => {
  assert.deepEqual([...REVIEW_REQUEST_OUTCOMES], [
    "sent",
    "clicked",
    "submitted",
    "routed_to_cs",
    "expired",
  ]);
});

test("REVIEW_REQUEST_NUDGE_DELAY_MS is 3 days (spec: 3-4 days)", () => {
  assert.equal(REVIEW_REQUEST_NUDGE_DELAY_MS, 3 * 24 * 60 * 60 * 1000);
});

test("REVIEW_REQUEST_CANARY_HOLD_MS is inside the spec's 12-24h range", () => {
  const twelveHrs = 12 * 60 * 60 * 1000;
  const twentyFourHrs = 24 * 60 * 60 * 1000;
  assert.ok(REVIEW_REQUEST_CANARY_HOLD_MS >= twelveHrs);
  assert.ok(REVIEW_REQUEST_CANARY_HOLD_MS <= twentyFourHrs);
});

test("mintReviewRequestToken returns a 24-hex-char token (96-bit entropy)", () => {
  const a = mintReviewRequestToken();
  const b = mintReviewRequestToken();
  assert.equal(a.length, 24);
  assert.equal(b.length, 24);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b, "two mints must not collide (probabilistically)");
});

test("pickReviewRequestChannel — SMS when subscribed", () => {
  const c = pickReviewRequestChannel({
    smsSubscribed: true,
    emailUnsubscribed: false,
  });
  assert.equal(c, "sms");
});

test("pickReviewRequestChannel — SMS wins over email even when unsubscribed from email", () => {
  const c = pickReviewRequestChannel({
    smsSubscribed: true,
    emailUnsubscribed: true,
  });
  assert.equal(c, "sms");
});

test("pickReviewRequestChannel — email when no SMS and email allowed", () => {
  const c = pickReviewRequestChannel({
    smsSubscribed: false,
    emailUnsubscribed: false,
  });
  assert.equal(c, "email");
});

test("pickReviewRequestChannel — null when NEITHER channel reachable", () => {
  const c = pickReviewRequestChannel({
    smsSubscribed: false,
    emailUnsubscribed: true,
  });
  assert.equal(c, null);
});

test("shouldSuppressReviewRequestNudge — already_nudged wins over every other signal", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "sent",
    nudgedAt: "2026-08-01T00:00:00Z",
    customerRepliedAfterSent: false,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "already_nudged");
});

test("shouldSuppressReviewRequestNudge — outcome=submitted suppresses", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "submitted",
    nudgedAt: null,
    customerRepliedAfterSent: false,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "outcome_submitted");
});

test("shouldSuppressReviewRequestNudge — outcome=routed_to_cs suppresses", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "routed_to_cs",
    nudgedAt: null,
    customerRepliedAfterSent: false,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "outcome_routed_to_cs");
});

test("shouldSuppressReviewRequestNudge — outcome=clicked suppresses", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "clicked",
    nudgedAt: null,
    customerRepliedAfterSent: false,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "outcome_clicked");
});

test("shouldSuppressReviewRequestNudge — outcome=expired suppresses", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "expired",
    nudgedAt: null,
    customerRepliedAfterSent: false,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "outcome_expired");
});

test("shouldSuppressReviewRequestNudge — customer replied to thread suppresses", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "sent",
    nudgedAt: null,
    customerRepliedAfterSent: true,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "customer_replied");
});

test("shouldSuppressReviewRequestNudge — customer unsubscribed suppresses", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "sent",
    nudgedAt: null,
    customerRepliedAfterSent: false,
    customerUnsubscribed: true,
  });
  assert.equal(v.suppress, true);
  assert.equal(v.reason, "customer_unsubscribed");
});

test("shouldSuppressReviewRequestNudge — a healthy sent+unresponded row proceeds", () => {
  const v = shouldSuppressReviewRequestNudge({
    outcome: "sent",
    nudgedAt: null,
    customerRepliedAfterSent: false,
    customerUnsubscribed: false,
  });
  assert.equal(v.suppress, false);
  assert.equal(v.reason, null);
});

test("isReviewRequestReadyForNudge — false for a 2-day-old ask", () => {
  const now = Date.parse("2026-08-05T00:00:00Z");
  const sentAt = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isReviewRequestReadyForNudge({ sentAt, now }), false);
});

test("isReviewRequestReadyForNudge — true for a 3-day-old ask", () => {
  const now = Date.parse("2026-08-05T00:00:00Z");
  const sentAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isReviewRequestReadyForNudge({ sentAt, now }), true);
});

test("isReviewRequestReadyForNudge — false when sentAt is null / bogus", () => {
  const now = Date.parse("2026-08-05T00:00:00Z");
  assert.equal(isReviewRequestReadyForNudge({ sentAt: null, now }), false);
  assert.equal(
    isReviewRequestReadyForNudge({ sentAt: "not-a-date", now }),
    false,
  );
});

test("composeReviewRequestNudgeBody — includes product name + link", () => {
  const body = composeReviewRequestNudgeBody({
    productName: "Sleep Gummies",
    reviewUrl: "https://x/journey/product-review/abc",
  });
  assert.match(body, /Sleep Gummies/);
  assert.match(body, /https:\/\/x\/journey\/product-review\/abc/);
  assert.match(body, /about a minute/);
});

test("composeReviewRequestNudgeBody — falls back gracefully on missing product name", () => {
  const body = composeReviewRequestNudgeBody({
    productName: "",
    reviewUrl: "https://x/journey/product-review/abc",
  });
  assert.match(body, /the product/);
});

test("reviewCanaryDigestDedupeKey — stable per (workspace, day, UTC)", () => {
  const d = new Date("2026-09-01T14:23:00Z");
  const k = reviewCanaryDigestDedupeKey("ws-1", d);
  assert.equal(k, "review_request_canary_digest:ws-1:2026-09-01");
});

test("composeReviewCanaryDigestBody — pluralizes noun + summarizes count", () => {
  const one = composeReviewCanaryDigestBody({
    count: 1,
    earliestSendAt: "2026-09-01T09:00:00Z",
    ticketLinks: ["/dashboard/tickets/abc"],
  });
  assert.match(one, /1 review request drafted/);
  assert.match(one, /2026-09-01T09:00:00Z/);
  const many = composeReviewCanaryDigestBody({
    count: 5,
    earliestSendAt: "2026-09-01T09:00:00Z",
    ticketLinks: [],
  });
  assert.match(many, /5 review requests drafted/);
});
