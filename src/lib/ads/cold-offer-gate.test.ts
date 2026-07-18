/**
 * cold-offer-gate tests — pins that hasColdOfferLeak refuses a cold-tagged creative whose composed
 * copy leaks LF8 offer/urgency language or bare price/percent tokens (the #1 DTC creative error
 * under Advantage+, where the creative IS the audience selector). The gate is DETERMINISTIC — the
 * probabilistic Max QC never has to catch this class.
 *
 * The predicate is temperature-agnostic (it just answers "does this copy leak?"), so the temperature
 * gating happens at the insertReadyCreative chokepoint (a cold row that leaks → skip; a warm/hot/null
 * row passes through untouched). The cases below cover both axes: leak-classification of the copy AND
 * how the caller must combine it with audience_temperature.
 *
 * Runs via: npx tsx --test src/lib/ads/cold-offer-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hasColdOfferLeak, COLD_OFFER_TOKENS } from "./lf8";

type Copy = { headline: string; primaryText: string; description: string };
type Temperature = "cold" | "warm" | "hot" | null;

/** Mirror the caller-side check the Phase-2 insertReadyCreative gate performs: fire only when
 *  temperature is 'cold' AND the composed copy leaks. Anything else passes. */
const gateBlocks = (t: Temperature, copy: Copy): boolean => t === "cold" && hasColdOfferLeak(copy);

const emptyRest = (headline: string): Copy => ({ headline, primaryText: "", description: "" });

test("cold + 'Save 25% today' trips the gate", () => {
  assert.equal(gateBlocks("cold", emptyRest("Save 25% today")), true);
});

test("cold + 'Energy that lasts through the afternoon' passes the gate", () => {
  assert.equal(gateBlocks("cold", emptyRest("Energy that lasts through the afternoon")), false);
});

test("warm + 'Save 25% today' passes the gate (gate only fires on cold)", () => {
  assert.equal(gateBlocks("warm", emptyRest("Save 25% today")), false);
});

test("null-temperature + 'Save 25% today' passes the gate (untagged → gate skips)", () => {
  assert.equal(gateBlocks(null, emptyRest("Save 25% today")), false);
});

test("cold + '$29 today' trips the gate (bare-currency regex)", () => {
  assert.equal(gateBlocks("cold", emptyRest("$29 today")), true);
});

test("cold + '20% off' trips the gate (bare-percent regex)", () => {
  assert.equal(gateBlocks("cold", emptyRest("20% off")), true);
});

test("COLD_OFFER_TOKENS colocates the LF8 offer/urgency cluster (SSOT — no drift)", () => {
  // The LF8 offer/urgency cluster (lf8.ts lines 41-42): save · off · free shipping · deal · today.
  // The gate MUST reuse these — a divergent list would let a hallucinated cold caption ship with
  // an LF8-flagged token the supervisor gate would still see.
  for (const t of ["save", "off", "free shipping", "deal", "today"]) {
    assert.ok(COLD_OFFER_TOKENS.includes(t), `expected COLD_OFFER_TOKENS to include LF8 offer/urgency token "${t}"`);
  }
});

test("hasColdOfferLeak scans all three copy fields (headline / primaryText / description)", () => {
  // A leak in any field trips the predicate — Meta renders all three, so a "clean headline" that
  // stuffs the offer into primary text is still a cold-mismatch.
  assert.equal(hasColdOfferLeak({ headline: "clean headline", primaryText: "Save 25% now", description: "" }), true);
  assert.equal(hasColdOfferLeak({ headline: "clean headline", primaryText: "", description: "$19 today" }), true);
});

test("hasColdOfferLeak lowercases before matching (mixed-case leaks still trip)", () => {
  assert.equal(hasColdOfferLeak(emptyRest("SAVE big TODAY")), true);
  assert.equal(hasColdOfferLeak(emptyRest("Free Shipping over $50")), true);
});

// ── debrand-offer-swap-prefers-our-real-offer-free-shipping-subscribe-and-save-offer-for-offer
// Phase 1 — the allowedOffer allowlist ───────────────────────────────────────────────────────
// When the caller passes OUR real brief.offer, the exact headline / disclaimer strings are
// stripped from the joined scan text BEFORE the leak predicate runs — so an offer-for-offer
// swap that renders our real offer verbatim (e.g. `Up to 34% off + free shipping` with
// disclaimer `with 3+ units on Subscribe & Save`) is NOT flagged as a cold-audience leak. A
// DIFFERENT discount (`50% off today`) still trips the gate because only the exact allowed
// phrases are removed.

const OUR_REAL_OFFER = {
  headline: "Up to 34% off + free shipping",
  disclaimer: "with 3+ units on Subscribe & Save",
};

test("offer-for-offer swap: OUR real offer verbatim in the headline is NOT a leak (allowedOffer allowlists it)", () => {
  const copy = emptyRest("Up to 34% off + free shipping");
  // Without the allowlist, the gate flags this ("off", "free shipping", "34% off").
  assert.equal(hasColdOfferLeak(copy), true);
  // With the allowlist, our real offer is stripped from the scan text — no leak.
  assert.equal(hasColdOfferLeak(copy, OUR_REAL_OFFER), false);
});

test("offer-for-offer swap: OUR real offer's disclaimer verbatim in the primary text is not a leak", () => {
  // The disclaimer alone doesn't carry an offer token, but this pins that a disclaimer text
  // (e.g. "with 3+ units on Subscribe & Save") is treated as allowed content.
  const copy = { headline: "Steady energy, all morning", primaryText: "with 3+ units on Subscribe & Save", description: "" };
  assert.equal(hasColdOfferLeak(copy, OUR_REAL_OFFER), false);
});

test("offer-for-offer swap: a DIFFERENT discount ('50% off today') still trips the gate even with allowedOffer", () => {
  // The allowlist is strict — a phrase we don't really run is NOT excused.
  const copy = emptyRest("50% off today");
  assert.equal(hasColdOfferLeak(copy, OUR_REAL_OFFER), true);
});

test("offer-for-offer swap: a bare currency ('$5') is still a leak even with allowedOffer (our real offer doesn't lead with a bare price)", () => {
  const copy = emptyRest("just $5 today");
  assert.equal(hasColdOfferLeak(copy, OUR_REAL_OFFER), true);
});

test("offer-for-offer swap: allowedOffer=null preserves the current (pre-Phase-1) behavior byte-for-byte", () => {
  const copy = emptyRest("Up to 34% off + free shipping");
  assert.equal(hasColdOfferLeak(copy, null), true);
  assert.equal(hasColdOfferLeak(copy, undefined), true);
});

test("offer-for-offer swap: allowedOffer with empty/whitespace headline is a no-op (falls through to today's behavior)", () => {
  const copy = emptyRest("Up to 34% off + free shipping");
  assert.equal(
    hasColdOfferLeak(copy, { headline: "   ", disclaimer: null }),
    true,
  );
});

test("offer-for-offer swap: allowedOffer matches case-insensitively (our real offer as 'UP TO 34% OFF + FREE SHIPPING' still allowlisted)", () => {
  const copy = emptyRest("UP TO 34% OFF + FREE SHIPPING");
  assert.equal(hasColdOfferLeak(copy, OUR_REAL_OFFER), false);
});
