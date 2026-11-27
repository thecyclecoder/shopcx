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
  planReminderSmsSend,
  buildReminderSmsBody,
  amountMatchesLastRenewal,
  type ReminderChargePreview,
} from "@/lib/pre-renewal-reminders";
import {
  isWithinSmsSendWindow,
  isValidIanaTimezone,
  SMS_WINDOW_START_HOUR,
  SMS_WINDOW_END_HOUR,
} from "@/lib/marketing-text-timezone";

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

/* ------------------------------------------------------------------------------------------------
 * Phase 1 — hard 9 AM-8 PM local send window for reminder texts (TCPA).
 * --------------------------------------------------------------------------------------------- */

/** The wall hour (0-23) of `instant` in `timezone`, for asserting a scheduled send is in-window. */
function localHour(instant: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(instant)
    .find((p) => p.type === "hour")?.value;
  return Number(h);
}

test("isValidIanaTimezone accepts real zones and rejects junk/empty/UTC-coerced strings", () => {
  for (const z of ["America/New_York", "Pacific/Auckland", "Pacific/Honolulu", "America/Los_Angeles"]) {
    assert.equal(isValidIanaTimezone(z), true, z);
  }
  for (const bad of ["Not/AZone", "", "   ", null, undefined, "Mars/Phobos"]) {
    assert.equal(isValidIanaTimezone(bad as string), false, String(bad));
  }
});

test("isWithinSmsSendWindow is true only for 9:00-19:59 local and false for an invalid zone", () => {
  const tz = "America/New_York"; // EST (UTC-5) on this date
  // 09:00 EST = 14:00 UTC (inclusive start).
  assert.equal(isWithinSmsSendWindow(new Date("2026-11-23T14:00:00Z"), tz), true);
  // 19:59 EST = 00:59 UTC next day (still in-window).
  assert.equal(isWithinSmsSendWindow(new Date("2026-11-24T00:59:00Z"), tz), true);
  // 08:59 EST = 13:59 UTC (before the window).
  assert.equal(isWithinSmsSendWindow(new Date("2026-11-23T13:59:00Z"), tz), false);
  // 20:00 EST = 01:00 UTC next day (end is exclusive).
  assert.equal(isWithinSmsSendWindow(new Date("2026-11-24T01:00:00Z"), tz), false);
  // Invalid zone is never in-window, whatever the instant.
  assert.equal(isWithinSmsSendWindow(new Date("2026-11-23T16:00:00Z"), "Not/AZone"), false);
});

// A 13:00 UTC run — the real cron hour. Each verified-tz recipient must schedule inside their
// local 9 AM-8 PM window, WITH a SendAt; invalid/fallback timezones must send no SMS.
const RUN_13Z = new Date("2026-11-23T13:00:00Z");

for (const tz of ["Pacific/Auckland", "Pacific/Honolulu", "America/Los_Angeles", "America/New_York"]) {
  test(`verified ${tz} recipient schedules at 11:00 local, inside the 9 AM-8 PM window, with a SendAt`, () => {
    const d = planReminderSmsSend({ timezone: tz }, RUN_13Z);
    assert.equal(d.send, true, `${tz} should get a scheduled text`);
    if (d.send) {
      assert.ok(d.sendAt instanceof Date && !Number.isNaN(d.sendAt.getTime()), "sendAt is a real Date");
      // Every scheduled send is provably between 9 AM and 8 PM local.
      assert.equal(isWithinSmsSendWindow(d.sendAt, tz), true, `${tz} sendAt within window`);
      const h = localHour(d.sendAt, tz);
      assert.ok(h >= SMS_WINDOW_START_HOUR && h < SMS_WINDOW_END_HOUR, `${tz} local hour ${h} in window`);
      assert.equal(h, 11, `${tz} targets 11:00 local`);
    }
  });
}

test("an invalid customers.timezone string sends NO text (email only), never UTC-coerced", () => {
  // The named failing state: an invalid IANA name was treated as UTC, so 11:00 UTC was already past
  // at 13:00 UTC and the text went out immediately (8 AM Eastern). Now it must suppress.
  const d = planReminderSmsSend({ timezone: "Not/AZone" }, RUN_13Z);
  assert.equal(d.send, false);
  if (!d.send) assert.equal(d.smsStatus, "suppressed_no_timezone");
});

test("an unresolvable timezone (fallback) sends NO text (email only)", () => {
  // The named failing state: a Hawaii/Alaska customer with no tz data fell back to America/Chicago
  // and got the 11 AM Central text at 7-8 AM local. Now fallback means email-only.
  const d = planReminderSmsSend({}, RUN_13Z); // no timezone, no zip, no phone → resolver falls back
  assert.equal(d.send, false);
  if (!d.send) assert.equal(d.smsStatus, "suppressed_no_timezone");
});

test("a passed local slot rolls to 11:00 local TOMORROW — scheduled, in-window, never immediate", () => {
  // 20:00 UTC = 15:00 EST, so today's 11:00 EST is already past → must schedule tomorrow 11:00 EST.
  const lateRun = new Date("2026-11-23T20:00:00Z");
  const d = planReminderSmsSend({ timezone: "America/New_York" }, lateRun);
  assert.equal(d.send, true);
  if (d.send) {
    assert.ok(d.sendAt.getTime() > lateRun.getTime(), "sendAt is in the future (has a SendAt)");
    assert.ok(d.sendAt.getTime() - lateRun.getTime() >= 16 * 60_000, "at least Twilio's min lead out");
    assert.equal(isWithinSmsSendWindow(d.sendAt, "America/New_York"), true);
    assert.equal(localHour(d.sendAt, "America/New_York"), 11);
    // Tomorrow, not today.
    assert.equal(d.sendAt.toISOString().slice(0, 10), "2026-11-24");
  }
});

test("buildReminderSmsBody uses the house block layout: hook / CTA+link / deadline, GSM-7, no blob", () => {
  const p: ReminderChargePreview = {
    subscriptionId: "s1",
    nextBillingDate: "2026-11-30",
    items: [{ title: "Daily Greens", quantity: 2 }],
    amountCents: 5500,
    shippingCents: 500,
    taxCents: null,
    amountLabel: "plus tax",
    comp: false,
  };
  const url = "https://superfd.co/j/abc123";
  const body = buildReminderSmsBody(p, url);
  const blocks = body.split("\n\n");
  assert.equal(blocks.length, 3, "three blocks separated by blank lines (not a word blob)");
  assert.match(blocks[0], /renews Nov 30 for \$55\.00 plus tax\./);
  // CTA label then the link on its OWN line, in the middle.
  assert.equal(blocks[1], `Review your order:\n${url}`);
  assert.match(blocks[2], /^Make changes before Nov 30\.$/);
  // GSM-7: no em/en dashes, no curly quotes, no emoji.
  assert.doesNotMatch(body, /[‒-―‘’“”]/, "no smart punctuation / dashes");
});

test("buildReminderSmsBody renders a comped renewal as 'on us', never a bare $0.00", () => {
  const p: ReminderChargePreview = {
    subscriptionId: "s1", nextBillingDate: "2026-11-30", items: [], amountCents: 0,
    shippingCents: 0, taxCents: 0, amountLabel: "total", comp: true,
  };
  const body = buildReminderSmsBody(p, "https://superfd.co/j/x");
  assert.match(body, /it is on us/);
  assert.doesNotMatch(body, /\$0\.00/);
});

/* ---- amountMatchesLastRenewal: the CEO 2026-11-27 renewal cross-check guardrail ---- */

test("amountMatchesLastRenewal: no prior order → matches (nothing to compare)", () => {
  const r = amountMatchesLastRenewal({ computedPreTaxCents: 5741, currentLineKey: "v1:1", activeOnTopCents: 0, spentOnTopCents: 0, last: null });
  assert.equal(r.matches, true);
});

test("amountMatchesLastRenewal: a double-discounted amount far below the last charge is FLAGGED", () => {
  // The bug symptom: last paid $45.17 net, no coupon change, but computed collapses to $29.28.
  const r = amountMatchesLastRenewal({
    computedPreTaxCents: 2928, currentLineKey: "v1:1", activeOnTopCents: 0, spentOnTopCents: 0,
    last: { lastPaidPreTaxCents: 4517, lineKey: "v1:1" },
  });
  assert.equal(r.matches, false);
  assert.equal(r.lastPaidPreTaxCents, 4517);
});

test("amountMatchesLastRenewal: a spent one-cycle coupon explains a HIGHER charge → matches", () => {
  // Ground truth 2: last order used the $15 coupon ($42.41 net); it is now spent, so the correct
  // $57.41 is $15 higher. The spent-coupon term accounts for it — not a mismatch.
  const r = amountMatchesLastRenewal({
    computedPreTaxCents: 5741, currentLineKey: "v1:1", activeOnTopCents: 0, spentOnTopCents: 1500,
    last: { lastPaidPreTaxCents: 4241, lineKey: "v1:1" },
  });
  assert.equal(r.matches, true);
});

test("amountMatchesLastRenewal: a newly-active coupon explains a LOWER charge → matches", () => {
  // A $15 coupon active this cycle legitimately drops the charge $15 below last time.
  const r = amountMatchesLastRenewal({
    computedPreTaxCents: 2741, currentLineKey: "v1:1", activeOnTopCents: 1500, spentOnTopCents: 0,
    last: { lastPaidPreTaxCents: 4241, lineKey: "v1:1" },
  });
  assert.equal(r.matches, true);
});

test("amountMatchesLastRenewal: changed line items → matches (a price change is expected)", () => {
  const r = amountMatchesLastRenewal({
    computedPreTaxCents: 9999, currentLineKey: "v1:2|v2:1", activeOnTopCents: 0, spentOnTopCents: 0,
    last: { lastPaidPreTaxCents: 4241, lineKey: "v1:1" },
  });
  assert.equal(r.matches, true);
});

test("amountMatchesLastRenewal: within $2 of last renewal → matches", () => {
  const r = amountMatchesLastRenewal({
    computedPreTaxCents: 4260, currentLineKey: "v1:1", activeOnTopCents: 0, spentOnTopCents: 0,
    last: { lastPaidPreTaxCents: 4241, lineKey: "v1:1" },
  });
  assert.equal(r.matches, true);
});
