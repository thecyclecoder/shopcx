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
