/**
 * Pins the shopcx dunning idempotency key to the caller's STABLE attempt ordinal.
 *
 * Shipped broken (live on main until 2026-09-15): `dunningChargeContract` accepted an
 * `attemptOrdinal` parameter, documented at length why a live `payment_failures` COUNT is unsafe
 * — and then built the key from that count anyway. The parameter was declared once and used never,
 * while every caller passed it correctly.
 *
 * Both failure modes are money bugs, and neither is visible to tsc:
 *   · an Inngest step retry re-reads a HIGHER count → NEW key → Shopify treats it as a new
 *     attempt → a SECOND REAL CHARGE against the same cycle;
 *   · two concurrent charge sites read the SAME count → SAME key → Shopify replays the cached
 *     decline → a customer's freshly-rotated good card is never presented, so recovery silently
 *     cannot succeed no matter how many times it runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "dunning-charge.ts"), "utf8");
const shopcxBranch = (() => {
  const start = SRC.indexOf('if (src === "shopcx")');
  assert.ok(start > 0, "the shopcx branch must exist");
  return SRC.slice(start, SRC.indexOf("// Appstle / internal:", start));
})();

test("the shopcx idempotency key is built from attemptOrdinal", () => {
  assert.match(
    shopcxBranch,
    /const key = `\$\{contractId\}:\$\{cycleKeyFromNextBillingDate\(due\)\}:r\$\{attemptOrdinal\}`/,
    "the key must use the caller's stable ordinal",
  );
});

test("the shopcx branch never derives the key from a live payment_failures count", () => {
  assert.doesNotMatch(
    shopcxBranch,
    /from\("payment_failures"\)/,
    "a live COUNT is neither stable across step retries nor isolated between concurrent charge sites",
  );
  assert.doesNotMatch(shopcxBranch, /:r\$\{count/);
});

test("the ordinal parameter is actually consumed, not just declared", () => {
  // The original defect was a parameter that appeared exactly once — in its own signature.
  const uses = SRC.split("attemptOrdinal").length - 1;
  assert.ok(uses >= 2, `attemptOrdinal appears ${uses}x — a single occurrence means it is declared and ignored`);
});
