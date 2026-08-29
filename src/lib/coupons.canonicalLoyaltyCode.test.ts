/**
 * Unit tests for `isCanonicalLoyaltyCode` + `escapeIlikeWildcards` — the
 * two pure defenses behind `ensureInternalLoyaltyCouponRow`'s LIKE-injection
 * guard. Spec:
 * loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value
 * § Phase 2 (Fix 1 — resolve 1 pre-merge spec-test regression).
 *
 * Failing state closed by these tests: pre-Phase-2 the materializer used
 * `.ilike("code", code)` / `.ilike("discount_code", code)` treating `%` and
 * `_` as literal chars — but PostgREST/Supabase forwards those verbatim to
 * PostgreSQL LIKE, so a caller submitting `LOYALTY-%` matched ANOTHER
 * customer's redemption in the workspace and got a fresh internal coupon
 * row minted onto their own contract with the OTHER customer's
 * `discount_value` (the CS-Director spec-test's "sec:real-vuln" finding on
 * `src/lib/coupons.ts:816` / `:847`).
 *
 * Run:
 *   npx tsx --test src/lib/coupons.canonicalLoyaltyCode.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isCanonicalLoyaltyCode, escapeIlikeWildcards } from "./coupons";

// ── isCanonicalLoyaltyCode ────────────────────────────────────────────

test("isCanonicalLoyaltyCode: accepts a real code minted by redeem_points", () => {
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP77G3"), true);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-5-ABCDEF"), true);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-10-XYZ234"), true);
});

test("isCanonicalLoyaltyCode: case-insensitive on letters (caller may send lower)", () => {
  assert.equal(isCanonicalLoyaltyCode("loyalty-15-up77g3"), true);
  assert.equal(isCanonicalLoyaltyCode("Loyalty-15-Up77g3"), true);
});

test("isCanonicalLoyaltyCode: REJECTS PostgreSQL LIKE wildcards (%) — the sec:real-vuln attack", () => {
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-%"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-%"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-%77G3"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP77%3"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-%-UP77G3"), false);
});

test("isCanonicalLoyaltyCode: REJECTS PostgreSQL LIKE wildcards (_)", () => {
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-_"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-_"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP__G3"), false);
});

test("isCanonicalLoyaltyCode: REJECTS partial prefixes / non-canonical shapes", () => {
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-ABC"), false);   // random too short
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-ABCDEFG"), false); // random too long
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-abc-DEFGHI"), false); // non-numeric value
});

test("isCanonicalLoyaltyCode: REJECTS other punctuation (backslash, dash, colon, etc.)", () => {
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP77\\3"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP-7G3"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP:7G3"), false);
  assert.equal(isCanonicalLoyaltyCode("LOYALTY-15-UP 7G3"), false);
});

test("isCanonicalLoyaltyCode: REJECTS non-string / null / empty", () => {
  assert.equal(isCanonicalLoyaltyCode(null), false);
  assert.equal(isCanonicalLoyaltyCode(undefined), false);
  assert.equal(isCanonicalLoyaltyCode(""), false);
  assert.equal(isCanonicalLoyaltyCode(123), false);
  assert.equal(isCanonicalLoyaltyCode({}), false);
});

test("isCanonicalLoyaltyCode: REJECTS non-LOYALTY prefixes even if the rest looks canonical", () => {
  assert.equal(isCanonicalLoyaltyCode("PROMO-15-UP77G3"), false);
  assert.equal(isCanonicalLoyaltyCode("SMILE-15-UP77G3"), false);
  assert.equal(isCanonicalLoyaltyCode("MASTER-15-UP77G3"), false);
});

// ── escapeIlikeWildcards (defense-in-depth) ──────────────────────────

test("escapeIlikeWildcards: literal string passes through unchanged", () => {
  assert.equal(escapeIlikeWildcards("LOYALTY-15-UP77G3"), "LOYALTY-15-UP77G3");
});

test("escapeIlikeWildcards: % is escaped to \\%", () => {
  assert.equal(escapeIlikeWildcards("LOYALTY-%"), "LOYALTY-\\%");
  assert.equal(escapeIlikeWildcards("%"), "\\%");
  assert.equal(escapeIlikeWildcards("100%OFF"), "100\\%OFF");
});

test("escapeIlikeWildcards: _ is escaped to \\_", () => {
  assert.equal(escapeIlikeWildcards("LOYALTY-_"), "LOYALTY-\\_");
  assert.equal(escapeIlikeWildcards("_"), "\\_");
});

test("escapeIlikeWildcards: backslash is escaped first so escapes don't re-escape", () => {
  assert.equal(escapeIlikeWildcards("\\"), "\\\\");
  assert.equal(escapeIlikeWildcards("a\\b"), "a\\\\b");
  // Combined — % arriving already-escaped in user input should still round-trip.
  assert.equal(escapeIlikeWildcards("\\%"), "\\\\\\%");
});

test("escapeIlikeWildcards: empty string round-trips", () => {
  assert.equal(escapeIlikeWildcards(""), "");
});
