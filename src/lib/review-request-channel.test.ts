/**
 * Regression tests for the 2026-09-08 CHANNEL outage.
 *
 *   npm run test:review-request-channel
 *
 * What happened: `pickReviewRequestChannel` chose sms-vs-email and the choice was
 * recorded on `review_requests.channel` — but `createPostOrderAnchorTicket`
 * hardcoded `channel: 'portal'`, and the outbox's portal branch is always-email.
 * So all 311 asks recorded as `sms` went out as EMAIL carrying the SMS body,
 * "Reply STOP to opt out" included. 249 customers received that in an inbox.
 * The channel column recorded a decision nothing downstream acted on.
 *
 * Two invariants are pinned here:
 *   1. the SMS body carries the carrier-convention STOP line and NO link-based
 *      opt-out; the EMAIL body carries a "don't ask me again" link and NO STOP.
 *   2. both bodies keep real blank-line paragraph breaks — SMS has no smart
 *      formatting, and the email path only renders paragraphs it can see.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { composeReviewRequestFirstTouchBody } from "./review-request-compose";

const base = {
  trigger: "post-order" as const,
  angle: "fence-sitter" as const,
  productName: "Amazing Coffee",
  customerFirstName: "Dylan",
  reviewUrl: "https://shopcx.ai/review/abc123def456abc123def456",
  window: "repeat" as const,
  tenureDays: 180,
};

test("SMS carries the carrier STOP line", () => {
  const { body } = composeReviewRequestFirstTouchBody({ ...base, channel: "sms" });
  assert.match(body, /Reply STOP to opt out\./);
});

test("SMS does NOT carry a link-based opt-out — a link in a text is worse than STOP", () => {
  const { body } = composeReviewRequestFirstTouchBody({ ...base, channel: "sms" });
  assert.ok(!/\/stop/.test(body), "SMS should not carry the /stop URL");
});

test("EMAIL never says 'Reply STOP' — that is what 249 inboxes received", () => {
  const { body } = composeReviewRequestFirstTouchBody({ ...base, channel: "email" });
  assert.ok(!/reply\s+stop/i.test(body), "an email telling someone to reply STOP is the outage");
});

test("EMAIL carries a one-click 'don't ask me again' link", () => {
  const { body } = composeReviewRequestFirstTouchBody({ ...base, channel: "email" });
  assert.match(body, /Turn them off here: https:\/\/shopcx\.ai\/review\/[A-Za-z0-9]+\/stop/);
});

test("the opt-out link is scoped to THIS ask's token, not a generic unsubscribe", () => {
  const { body } = composeReviewRequestFirstTouchBody({ ...base, channel: "email" });
  assert.ok(body.includes(`${base.reviewUrl}/stop`), "must hang off the ask's own token");
});

test("both channels keep blank-line paragraph breaks", () => {
  for (const channel of ["sms", "email"] as const) {
    const { body } = composeReviewRequestFirstTouchBody({ ...base, channel });
    assert.ok(
      body.includes("\n\n"),
      `${channel}: SMS has no smart formatting and the email renderer only paragraphs what it can see`,
    );
  }
});

test("the review link sits on its own line on both channels", () => {
  for (const channel of ["sms", "email"] as const) {
    const { body } = composeReviewRequestFirstTouchBody({ ...base, channel });
    const line = body.split("\n").find((l) => l.trim() === base.reviewUrl);
    assert.ok(line !== undefined, `${channel}: the CTA link must be isolated so it stays tappable`);
  }
});

test("email gets a subject, SMS does not", () => {
  assert.ok(composeReviewRequestFirstTouchBody({ ...base, channel: "email" }).subject.length > 0);
  assert.equal(composeReviewRequestFirstTouchBody({ ...base, channel: "sms" }).subject, "");
});
