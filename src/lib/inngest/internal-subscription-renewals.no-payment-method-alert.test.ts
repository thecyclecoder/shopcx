/**
 * Pins `shouldAlertNoPaymentMethod` — the human-facing signal for the one renewal skip that can
 * loop forever unseen.
 *
 * The wedge is the 2026-08-12 audit: three internal subs sat stuck for 20-24 days ($397.72 of
 * renewals) because `no_payment_method` does NOT advance `next_billing_date` — so the sub is
 * re-picked and re-skipped every day — and it emitted only a Control Tower beat that reads as a
 * routine skip. Every one of them had a valid Braintree token merely missing `is_default`. The
 * other two holds already write a `needs_attention` event; this one didn't.
 *
 * Run: npx tsx --test src/lib/inngest/internal-subscription-renewals.no-payment-method-alert.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldAlertNoPaymentMethod,
  NO_PAYMENT_METHOD_ALERT_DEDUPE_MS,
} from "./internal-subscription-renewals";

const NOW = new Date("2026-08-12T09:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

test("a never-alerted no_payment_method skip alerts", () => {
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", null, NOW), true);
});

test("only no_payment_method alerts — other skips stay silent", () => {
  // These are benign state changes or already carry their own event; alerting on them would
  // drown the signal this test exists to protect.
  for (const reason of ["not_internal", "status_paused", "no_customer", "customer_not_found", "no_recipient_name"])
    assert.equal(shouldAlertNoPaymentMethod(reason, null, NOW), false, reason);
});

test("a second skip the same day does NOT re-alert", () => {
  // The attempt repeats daily; without dedupe the timeline gets an identical row every day.
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", ago(60 * 60 * 1000), NOW), false);
});

test("it re-alerts once the dedupe window has fully elapsed", () => {
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", ago(NO_PAYMENT_METHOD_ALERT_DEDUPE_MS - 1), NOW), false);
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", ago(NO_PAYMENT_METHOD_ALERT_DEDUPE_MS), NOW), true);
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", ago(30 * 86400000), NOW), true);
});

test("a stuck sub keeps resurfacing rather than going quiet forever", () => {
  // The failure this guards against is silence. Over 8 weeks of daily skips a sub must alert
  // repeatedly, not once.
  let last: Date | null = null;
  let alerts = 0;
  for (let day = 0; day < 56; day++) {
    const t = new Date(NOW.getTime() + day * 86400000);
    if (shouldAlertNoPaymentMethod("no_payment_method", last, t)) { alerts++; last = t; }
  }
  assert.equal(alerts, 8, "one alert per week over 8 weeks");
});

test("an unparseable timestamp alerts rather than swallowing the signal", () => {
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", "not-a-date", NOW), true);
});

test("accepts an ISO string as well as a Date", () => {
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", ago(3600_000).toISOString(), NOW), false);
  assert.equal(shouldAlertNoPaymentMethod("no_payment_method", ago(30 * 86400000).toISOString(), NOW), true);
});
