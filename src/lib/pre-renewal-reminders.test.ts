/**
 * Unit tests for the pre-renewal reminder pure core (pre-renewal-reminder-sends).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/pre-renewal-reminders.test.ts
 *
 * The DB-dependent paths (scan / ledger / sends) are integration-tested via the spec's
 * Verification checklist. The tests below pin the PURE legal gate the SMS channel rests
 * on — the exact named states from Phase 3: a STOP'd customer and a non-consented
 * customer must BOTH be suppressed (and distinguishably so), while a consented customer
 * with a good phone is allowed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifySmsConsent, fmtPreviewAmount, type ReminderChargePreview } from "@/lib/pre-renewal-reminders";

function preview(over: Partial<ReminderChargePreview>): ReminderChargePreview {
  return {
    subscriptionId: "sub-1",
    nextBillingDate: "2026-11-30",
    items: [],
    amountCents: null,
    shippingCents: null,
    taxCents: null,
    amountLabel: "plus tax",
    ...over,
  };
}

test("a tax-inclusive 'total' renders as a bare dollar amount", () => {
  const s = fmtPreviewAmount(preview({ amountCents: 4999, taxCents: 412, amountLabel: "total" }));
  assert.equal(s, "$49.99");
});

test("an unquoted-tax amount renders '$X plus tax', NEVER a bare pre-tax number", () => {
  // The named failing state: a pre-tax figure must not be shown as if it were the full charge.
  const s = fmtPreviewAmount(preview({ amountCents: 4999, taxCents: null, amountLabel: "plus tax" }));
  assert.equal(s, "$49.99 plus tax");
});

test("an unresolved amount renders nothing (reminder omits it)", () => {
  assert.equal(fmtPreviewAmount(preview({ amountCents: null })), null);
});

test("STOP (unsubscribed) is suppressed as suppressed_stop — never texted", () => {
  const v = classifySmsConsent({ sms_marketing_status: "unsubscribed", phone: "+15125551234" });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.smsStatus, "suppressed_stop");
});

test("never-consented is suppressed as suppressed_no_consent", () => {
  const v = classifySmsConsent({ sms_marketing_status: "not_subscribed", phone: "+15125551234" });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.smsStatus, "suppressed_no_consent");
});

test("subscribed but no phone is suppressed", () => {
  const v = classifySmsConsent({ sms_marketing_status: "subscribed", phone: null });
  assert.equal(v.allowed, false);
});

test("subscribed with a bad phone_status is suppressed", () => {
  const v = classifySmsConsent({ sms_marketing_status: "subscribed", phone: "+15125551234", phone_status: "invalid" });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.smsStatus, "suppressed_no_consent");
});

test("subscribed + good phone is allowed", () => {
  const good = classifySmsConsent({ sms_marketing_status: "subscribed", phone: "+15125551234", phone_status: "good" });
  assert.equal(good.allowed, true);
  // phone_status null (never flagged) is also allowed.
  const nullStatus = classifySmsConsent({ sms_marketing_status: "subscribed", phone: "+15125551234", phone_status: null });
  assert.equal(nullStatus.allowed, true);
});

test("null/undefined customer is suppressed, not allowed", () => {
  assert.equal(classifySmsConsent(null).allowed, false);
  assert.equal(classifySmsConsent(undefined).allowed, false);
});
