/**
 * Pins the two invariants that make a PDP-created contract billable by our engine.
 *
 * Shopify's checkout and our migration produce structurally DIFFERENT contracts, and only one of
 * them our pricing can read. Measured on contract 36020093101 (order SC138756, 2026-09-15):
 *
 *   PDP:       currentPrice $52.46/unit, ZERO allocations  — the selling plan's 25% is baked INTO
 *              the unit price, and the quantity break never reaches the contract at all because
 *              Shopify's AUTOMATIC discounts are a checkout mechanism that does not run on an
 *              app-led billing attempt.
 *   migrated:  currentPrice $69.95 (catalog MSRP) + "Subscribe & Save" 25% + "Volume discount" 8%
 *
 * `rewriteStructuralDiscounts` treats currentPrice as the PRE-discount base, so on an un-normalized
 * PDP contract the first line edit would apply 25% + 8% to an already-discounted $52.46 and bill
 * $36.20/unit instead of $48.27 — a double discount on every renewal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "shopcx-line-ops.ts"), "utf8");
const fn = SRC.slice(SRC.indexOf("export async function shopcxNormalizeNewContract"));

test("only rebases a line priced below MSRP with NO allocation explaining it", () => {
  // That conjunction is the selling-plan-baked signature. Dropping either half would rebase a
  // GRANDFATHERED line (below MSRP on purpose) and silently raise the customer's price.
  assert.match(fn, /unit < v\.price_cents && l\.structuralDiscountCents === 0/);
});

test("rebase and recompute commit in the SAME draft", () => {
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const rebaseAt = body.indexOf("shopifyUpdateDraftLine");
  const recomputeAt = body.indexOf("rewriteStructuralDiscounts");
  const draftAt = body.indexOf("withDraft");
  assert.ok(draftAt > 0 && draftAt < rebaseAt && rebaseAt < recomputeAt,
    "both writes must happen inside one withDraft — committed separately, a charge landing between them bills full MSRP with no discounts");
});

test("it is idempotent — a contract already in our shape is left alone", () => {
  assert.match(fn, /return \{ success: true, normalized: false \}/);
});

test("a cancelled or expired contract is never touched", () => {
  assert.match(fn, /status !== "ACTIVE" && live\.contract\.status !== "PAUSED"/);
});
