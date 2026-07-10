/**
 * Unit tests for classifyCheckoutStuck — Phase 1 of
 * docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
 *
 * Pins the three Phase 1 verification bullets:
 *   1. Every listed keyword category (can't check out / OTP not arriving /
 *      stuck at payment screen / how do I finish my order) routes to the
 *      checkout-stuck bucket.
 *   2. Ticket aa0b6697's message classifies as checkout-stuck, NOT `account` —
 *      re-created via a fixture derived from the spec's description of Latrina
 *      C.'s Shopify Shop-Pay-OTP-never-arrived situation.
 *   3. Negative: a plain order-status or account question does NOT trip
 *      checkout-stuck.
 *
 * Pure — no DB, no network. Run:
 *   npx tsx --test src/lib/checkout-stuck-intent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyCheckoutStuck, CHECKOUT_STUCK_BUCKET } from "./checkout-stuck-intent";

// ── Positive: every listed keyword category ────────────────────────────────

test("cue: can't check out", () => {
  const r = classifyCheckoutStuck("I can't check out on your site — nothing happens when I press pay.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "cant_check_out");
});

test("cue: cannot complete my order", () => {
  const r = classifyCheckoutStuck("I cannot complete my order, the last screen just spins.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "cant_check_out");
});

test("cue: OTP text isn't arriving", () => {
  const r = classifyCheckoutStuck("The Shop Pay verification code isn't arriving on my phone.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "otp_not_arriving");
});

test("cue: never got the verification code", () => {
  const r = classifyCheckoutStuck("I never got the verification text after entering my number.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "no_code_received");
});

test("cue: stuck at the payment screen", () => {
  const r = classifyCheckoutStuck("Been stuck on the payment page for 20 minutes — help?");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "stuck_at_payment_screen");
});

test("cue: stuck at the OTP step", () => {
  const r = classifyCheckoutStuck("I'm stuck at the OTP step — it just keeps asking me to log in.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "stuck_at_payment_screen");
});

test("cue: how do I finish my order", () => {
  const r = classifyCheckoutStuck("How do I finish my order? I picked the items but can't get past the pay screen.");
  assert.equal(r.matched, true);
  // First match wins; "can't get past the pay screen" is a `cant_check_out`
  // cue, which comes before `how_do_i_finish` in the catalog. Either is
  // acceptable evidence — assert on the winning cue's presence in the enum.
  assert.ok(r.cue === "how_do_i_finish" || r.cue === "cant_check_out", `unexpected cue: ${r.cue}`);
});

test("cue: how can I finish my purchase", () => {
  const r = classifyCheckoutStuck("How can I finish my purchase? I keep looping back to the login page.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "how_do_i_finish");
});

test("cue: checkout isn't working", () => {
  const r = classifyCheckoutStuck("Checkout isn't working — it errors out every time.");
  assert.equal(r.matched, true);
  assert.equal(r.cue, "checkout_not_working");
});

// ── The aa0b6697 fixture ──────────────────────────────────────────────────

test("aa0b6697 fixture — Shop Pay OTP never arrived — classifies checkout-stuck, NOT account", () => {
  // Derived from the spec's description: "Latrina C. couldn't complete on the
  // Shopify checkout (Shopify pushes Shop Pay OTP login; the OTP text never
  // arrived)." A realistic phrasing that would land in her ticket.
  const msg =
    "Hi, I was trying to order but the Shop Pay verification code never arrived on my phone, so I can't check out. Can you help?";
  const r = classifyCheckoutStuck(msg);
  assert.equal(r.matched, true, "aa0b6697 fixture must classify as checkout-stuck");
  // Either OTP-not-arriving OR can't-check-out is a valid label; the point of
  // the test is that the fixture does NOT fall through to `matched=false`
  // (which is what caused her ticket to fall into the coarse `account` bucket).
  assert.ok(
    r.cue === "otp_not_arriving" || r.cue === "cant_check_out",
    `unexpected cue on aa0b6697 fixture: ${r.cue}`,
  );
});

// ── Negatives: plain order-status / account questions do NOT trip ────────

test("negative: order-status question does not match", () => {
  const r = classifyCheckoutStuck("Where is my order? It's been a week and I haven't seen a tracking update.");
  assert.equal(r.matched, false);
});

test("negative: cancel-subscription question does not match", () => {
  const r = classifyCheckoutStuck("How do I cancel my subscription? I don't want the next shipment.");
  assert.equal(r.matched, false);
});

test("negative: refund request does not match", () => {
  const r = classifyCheckoutStuck("I'd like a refund on my last order — the coffee arrived stale.");
  assert.equal(r.matched, false);
});

test("negative: address-change request does not match", () => {
  const r = classifyCheckoutStuck("Can you change my shipping address for the next order? I've moved.");
  assert.equal(r.matched, false);
});

test("negative: ingredient question does not match", () => {
  const r = classifyCheckoutStuck("Does the greens powder have any added sugar?");
  assert.equal(r.matched, false);
});

test("negative: empty / whitespace / null does not match", () => {
  assert.equal(classifyCheckoutStuck("").matched, false);
  assert.equal(classifyCheckoutStuck("   ").matched, false);
  assert.equal(classifyCheckoutStuck(null).matched, false);
  assert.equal(classifyCheckoutStuck(undefined).matched, false);
});

// ── Constants ─────────────────────────────────────────────────────────────

test("CHECKOUT_STUCK_BUCKET is the string 'checkout-stuck' — distinct from the coarse buckets", () => {
  assert.equal(CHECKOUT_STUCK_BUCKET, "checkout-stuck");
  assert.notEqual(CHECKOUT_STUCK_BUCKET as string, "account");
  assert.notEqual(CHECKOUT_STUCK_BUCKET as string, "general");
  assert.notEqual(CHECKOUT_STUCK_BUCKET as string, "outreach");
});
