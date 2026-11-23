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
import {
  classifySmsConsent,
  fmtPreviewAmount,
  reminderChargePreview,
  type ReminderChargePreview,
} from "@/lib/pre-renewal-reminders";

function preview(over: Partial<ReminderChargePreview>): ReminderChargePreview {
  return {
    subscriptionId: "sub-1",
    nextBillingDate: "2026-11-30",
    items: [],
    amountCents: null,
    shippingCents: null,
    taxCents: null,
    amountLabel: "plus tax",
    comp: false,
    ...over,
  };
}

/** A minimal admin stub whose `subscriptions` select resolves to `subRow` — enough for
 *  `reminderChargePreview` on a non-internal (ShopCX) sub, which never hits the tax quote path. */
function fakeAdmin(subRow: Record<string, unknown> | null): Parameters<typeof reminderChargePreview>[2] {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: subRow }),
  };
  return { from: () => q } as unknown as Parameters<typeof reminderChargePreview>[2];
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

test("a comped renewal renders 'This order is on us', never a bare $0.00", () => {
  // The named failing state: a free sub must not show "$0.00".
  const s = fmtPreviewAmount(preview({ comp: true, amountCents: 0, taxCents: 0, amountLabel: "total" }));
  assert.equal(s, "This order is on us");
});

test("a ShopCX-shape sub with price_cents lines yields a non-null amount (one money resolver)", async () => {
  // The CEO 2026-11-23 bug: ShopCX lines carry `price_cents`, so the old hand-sum of `items[].price`
  // resolved every ShopCX sub to no amount. priceSubscription sums `price_cents` for all engines.
  const sub = {
    id: "sub-shopcx",
    is_internal: false,
    comp: false,
    items: [{ title: "Daily Greens", quantity: 2, price_cents: 2500, variant_id: "v1" }],
    delivery_price_cents: 500,
    applied_discounts: [],
    shipping_protection_added: false,
    shipping_protection_amount_cents: 0,
    next_billing_date: "2026-11-30",
  };
  const p = await reminderChargePreview("ws-1", "sub-shopcx", fakeAdmin(sub));
  assert.ok(p, "preview resolved");
  assert.equal(p!.amountCents, 5500); // 2×$25.00 + $5.00 shipping
  assert.equal(p!.comp, false);
  assert.equal(p!.amountLabel, "plus tax"); // Shopify applies tax at billing
  assert.equal(fmtPreviewAmount(p!), "$55.00 plus tax");
});

test("a comped ShopCX sub yields the free wording, not an amount", async () => {
  const sub = {
    id: "sub-comp",
    is_internal: false,
    comp: true,
    items: [{ title: "Daily Greens", quantity: 1, price_cents: 2500, variant_id: "v1" }],
    delivery_price_cents: 0,
    applied_discounts: [],
    shipping_protection_added: false,
    shipping_protection_amount_cents: 0,
    next_billing_date: "2026-11-30",
  };
  const p = await reminderChargePreview("ws-1", "sub-comp", fakeAdmin(sub));
  assert.ok(p, "preview resolved");
  assert.equal(p!.comp, true);
  assert.equal(fmtPreviewAmount(p!), "This order is on us");
});

test("a ShopCX sub whose lines are all $0 is treated as comped even without sub.comp", async () => {
  const sub = {
    id: "sub-zero",
    is_internal: false,
    comp: false,
    items: [{ title: "Free Gift Box", quantity: 1, price_cents: 0, variant_id: "v1" }],
    delivery_price_cents: 0,
    applied_discounts: [],
    shipping_protection_added: false,
    shipping_protection_amount_cents: 0,
    next_billing_date: "2026-11-30",
  };
  const p = await reminderChargePreview("ws-1", "sub-zero", fakeAdmin(sub));
  assert.ok(p, "preview resolved");
  assert.equal(p!.comp, true);
  assert.equal(fmtPreviewAmount(p!), "This order is on us");
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
