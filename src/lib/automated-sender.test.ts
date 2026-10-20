/**
 * Unit tests for the Phase-2 automated-sender pre-filter.
 *
 * Pin the exact behavior the spec's verification bullets require:
 *   (1) automated senders (e.g. testflight_no_reply@email.apple.com) → true (short-circuit fires,
 *       classify-bucket step never runs → zero AI cost);
 *   (2) genuine customer email from a normal address → false (no false positive);
 *   (3) human brand-collab outreach (real Gmail/Yahoo address) → false (falls through to the
 *       cheap Haiku classifier, then Phase 1's deterministic close).
 *
 *   npx tsx --test src/lib/automated-sender.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isAutomatedSender,
  bodyHasAutomatedMarker,
  isAutomatedInbound,
  bodyHasAutoReplyOrNotificationMarker,
  isAutoReplyOrNotificationInbound,
} from "./automated-sender";

test("verification bullet 1 — testflight_no_reply@email.apple.com trips the pre-filter", () => {
  assert.equal(isAutomatedSender("testflight_no_reply@email.apple.com"), true);
});

test("no-reply / no_reply / donotreply local parts all trip", () => {
  assert.equal(isAutomatedSender("noreply@stripe.com"), true);
  assert.equal(isAutomatedSender("no-reply@shopify.com"), true);
  assert.equal(isAutomatedSender("no_reply@example.com"), true);
  assert.equal(isAutomatedSender("donotreply@bank.com"), true);
  assert.equal(isAutomatedSender("do-not-reply@vendor.com"), true);
  assert.equal(isAutomatedSender("do_not_reply@vendor.com"), true);
});

test("mailer daemons / postmaster / bounces trip", () => {
  assert.equal(isAutomatedSender("MAILER-DAEMON@googlemail.com"), true);
  assert.equal(isAutomatedSender("postmaster@example.com"), true);
  assert.equal(isAutomatedSender("bounce@x.com"), true);
  assert.equal(isAutomatedSender("bounces@x.com"), true);
});

test("known automated-notification domains trip on ANY local part (and any subdomain)", () => {
  assert.equal(isAutomatedSender("receipts@email.apple.com"), true);
  assert.equal(isAutomatedSender("notifications@noreply.github.com"), true);
  assert.equal(isAutomatedSender("anything@push.email.apple.com"), true);
});

test("verification bullet 2 — genuine customer email is NOT tripped (no false positive)", () => {
  assert.equal(isAutomatedSender("dylan@apptivi.com"), false);
  assert.equal(isAutomatedSender("customer@gmail.com"), false);
  assert.equal(isAutomatedSender("j.smith@yahoo.co.uk"), false);
  assert.equal(isAutomatedSender("first.last+ordertag@outlook.com"), false);
});

test("verification bullet 3 — brand-collab senders on normal domains fall through", () => {
  // Real cold-outreach domains (personal Gmail, agency, etc.) don't trip — Phase 1 catches them.
  assert.equal(isAutomatedSender("collab.mgr@ugcpartners.com"), false);
  assert.equal(isAutomatedSender("hello@creator.co"), false);
  assert.equal(isAutomatedSender("outreach@bigmarketing.io"), false);
});

test("null / empty / malformed addresses return false — no accidental short-circuit", () => {
  assert.equal(isAutomatedSender(null), false);
  assert.equal(isAutomatedSender(undefined), false);
  assert.equal(isAutomatedSender(""), false);
  assert.equal(isAutomatedSender("no-at-sign"), false);
  assert.equal(isAutomatedSender("@no-local"), false);
  assert.equal(isAutomatedSender("no-domain@"), false);
});

test("standalone-mailer regex is exact-match — 'postmaster.eu@x.com' does NOT trip", () => {
  // Guards against a human whose handle happens to contain 'bounce' or 'postmaster' as substring.
  assert.equal(isAutomatedSender("postmaster.eu@x.com"), false);
  assert.equal(isAutomatedSender("bouncehouse@events.com"), false);
});

test("look-alike domains do NOT trip — email.apple.com only, not apple.com", () => {
  assert.equal(isAutomatedSender("tim@apple.com"), false);
  assert.equal(isAutomatedSender("alice@notapple.com"), false);
});

test("body markers — 'please do not reply' + 'this is an automated' trip", () => {
  assert.equal(bodyHasAutomatedMarker("Please do not reply to this email. Your order shipped."), true);
  assert.equal(bodyHasAutomatedMarker("This is an automated notification from our system."), true);
  assert.equal(bodyHasAutomatedMarker("This mailbox is not monitored — visit our help center."), true);
  assert.equal(bodyHasAutomatedMarker("You are receiving this email because you subscribed to updates."), true);
});

test("body markers — genuine customer body does NOT trip", () => {
  assert.equal(bodyHasAutomatedMarker("Hi, where's my order? I paid last week."), false);
  assert.equal(bodyHasAutomatedMarker(null), false);
  assert.equal(bodyHasAutomatedMarker(""), false);
});

test("isAutomatedInbound — either sender OR body signal is sufficient", () => {
  // Sender only.
  assert.equal(isAutomatedInbound("noreply@stripe.com", "Your account was updated."), true);
  // Body only (human-looking sender but the body is unmistakably an automated notification).
  assert.equal(isAutomatedInbound("news@retailer.com", "Please do not reply to this email."), true);
  // Neither.
  assert.equal(isAutomatedInbound("customer@gmail.com", "Where's my order?"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-reply / OOO / vendor-notification exemption — the broader classifier used ONLY by the
// CS Director close_no_action guard ([[../../docs/brain/specs/close-no-action-guard-must-exempt-notification-and-auto-reply-emails.md]]).
// ─────────────────────────────────────────────────────────────────────────────

test("vendor Terms/Privacy-update blast trips the notification marker (ticket f3977ec6)", () => {
  assert.equal(
    bodyHasAutoReplyOrNotificationMarker(
      "We've updated our Terms of Service and Privacy Policy. Please review the changes.",
    ),
    true,
  );
});

test("out-of-office / vacation auto-replies trip the auto-reply marker", () => {
  assert.equal(bodyHasAutoReplyOrNotificationMarker("I am currently out of office until Monday."), true);
  assert.equal(bodyHasAutoReplyOrNotificationMarker("Automatic reply: I'm on vacation this week."), true);
});

test("isAutoReplyOrNotificationInbound is a superset of isAutomatedInbound", () => {
  // no-reply sender → both true
  assert.equal(isAutoReplyOrNotificationInbound("no-reply@vendor.com", "anything"), true);
  // vendor blast body with a normal sender → only the broader predicate fires
  assert.equal(isAutomatedInbound("team@gemx.net", "We've updated our Terms of Service"), false);
  assert.equal(isAutoReplyOrNotificationInbound("team@gemx.net", "We've updated our Terms of Service"), true);
});

test("a real customer asking us to update their address does NOT trip (false-positive averse)", () => {
  assert.equal(
    bodyHasAutoReplyOrNotificationMarker("Can you please update my shipping address to 5 Main St?"),
    false,
  );
  assert.equal(
    bodyHasAutoReplyOrNotificationMarker("Please change my next delivery date to the 15th."),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Chargeback-mitigation / dispute-vendor blast exemption — ticket 5dcb1240.
// chargebackgurus.com / FPRONE automated "please attempt refund for Alert ID …" templates carry
// no customer identity and no actionable ask, yet the 'refund' cue in findUnsatisfiedCustomerRequests
// downgrades a correct close_no_action into an endless Sol re-session loop.
// ─────────────────────────────────────────────────────────────────────────────

test("chargeback-vendor FPRONE 'attempt refund for Alert ID' blast trips the notification marker (ticket 5dcb1240)", () => {
  const vendorBody =
    "FPRONE Dispute Alert. Please attempt a refund for Alert ID CBG-88213 in your Gateway " +
    "within 24 hours to avoid a chargeback. — ChargebackGurus";
  assert.equal(bodyHasAutoReplyOrNotificationMarker(vendorBody), true);
});

test("chargeback-vendor sender domain (support@chargebackgurus.com) trips via isAutoReplyOrNotificationInbound", () => {
  const vendorBody =
    "Please attempt a refund for Alert ID CBG-88213 in your Gateway to avoid a chargeback.";
  // Sender-domain signal alone is sufficient for the close-gate exemption.
  assert.equal(isAutoReplyOrNotificationInbound("support@chargebackgurus.com", "any body"), true);
  assert.equal(isAutoReplyOrNotificationInbound("abdulsalam.a@chargebackgurus.com", vendorBody), true);
});

test("a real customer refund request does NOT trip the chargeback-vendor exemption (false-positive averse)", () => {
  assert.equal(bodyHasAutoReplyOrNotificationMarker("I want a refund for my last order please."), false);
  assert.equal(bodyHasAutoReplyOrNotificationMarker("Please refund me, the package never arrived."), false);
  assert.equal(
    isAutoReplyOrNotificationInbound("customer@gmail.com", "Can I get a refund? My order was wrong."),
    false,
  );
});
