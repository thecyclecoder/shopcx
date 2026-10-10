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

test("only touches a rule line with NO structural allocation, priced at or below MSRP", () => {
  // No-allocation is the checkout signature. Dropping it would rebase a GRANDFATHERED line (below
  // MSRP on purpose, carrying a Legacy rate) and silently raise the customer's price.
  assert.match(fn, /unit <= v\.price_cents && l\.structuralDiscountCents === 0/);
});

test("rebases only lines BELOW MSRP; an at-MSRP line just gets its discounts", () => {
  // At MSRP is the S&S-from-a-discount-function shape: nothing to rebase, but without our own
  // "Subscribe & Save" it renews at full price. It must still reach the recompute.
  assert.match(fn, /needsDiscounts = true;\s*if \(unit < v\.price_cents\) \{\s*planBaked = true;\s*toRebase\.push/);
  assert.match(fn, /if \(!needsDiscounts\) return \{ success: true, normalized: false \}/);
});

test("protection gets the S&S baked into its own price in the function shape only", () => {
  // Dylan 2026-10-10: the checkout function discounts protection too ($6.60 → $4.95). On the
  // contract that is an inert automatic, so without this it renews at $6.60. Protection keeps the
  // migration convention (final price in currentPrice, no S&S/Volume allocations), so it is a price
  // move, gated on the RULE lines' shape: at MSRP (function) yes, below MSRP (plan-baked) no.
  assert.match(fn, /if \(needsDiscounts && !planBaked && ctx\.snsPct > 0\) \{\s*for \(const \{ lineId, unit \} of protectionLines\)/);
  assert.match(fn, /targetCents: Math\.round\(\(unit \* \(100 - ctx\.snsPct\)\) \/ 100\)/);
  assert.match(fn, /if \(unit < v\.price_cents\) \{\s*planBaked = true;/);
  // Never from protection's catalog price, which lags the store.
  assert.doesNotMatch(fn, /isProtection\(ctx, v\.product_id\)\) \{[^}]*v\.price_cents/);
  // The recompute still never gives protection structural discounts.
  assert.match(SRC, /function rewriteStructuralDiscounts[\s\S]*?ruleProducts\.has\(v\.product_id\) \|\| isProtection\(ctx, v\.product_id\)\) continue;/);
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

test("shop-wide AUTOMATIC discounts are never treated as the customer's coupon", () => {
  // Shopify copies shop automatics onto the contract at checkout — verified on 36020289709, which
  // carries "Free Shipping on Subscriptions" and "Buy 2 Discount" as AUTOMATIC_DISCOUNT entities.
  // `shopcxApplyCoupon` removes existing coupons before adding, so misclassifying these meant
  // applying ANY coupon to a ShopCX sub silently stripped the customer's FREE SHIPPING.
  const ops = readFileSync(join(__dirname, "shopcx-discount-ops.ts"), "utf8");
  assert.match(ops, /const isAutomatic = \(d: \{ type: string \| null \}\) => d\.type === "AUTOMATIC_DISCOUNT"/);
  assert.match(ops, /!isStructural\(d\) && !isAutomatic\(d\)/);
});

test("the recompute replaces checkout LINE_ITEM automatic copies with our own discounts", () => {
  // Dylan 2026-10-10: the S&S / Buy 2-3 functions apply on EVERY cycle so checkout shows the
  // discounted recurring price. Shopify copies them onto the contract as live recurring automatics;
  // left there they stack with ours (double discount) and never follow a quantity change (a Buy 3
  // rate living on after a downgrade). Shipping automatics and customer codes stay.
  const rewrite = SRC.slice(SRC.indexOf("async function rewriteStructuralDiscounts"), SRC.indexOf("async function preparePricing"));
  assert.match(rewrite, /d\.type === "AUTOMATIC_DISCOUNT" && d\.targetType === "LINE_ITEM"/);
  assert.match(rewrite, /shopifyRemoveDraftDiscount\(workspaceId, draftId, d\.id\)/);
  // Removal happens before our discounts are re-added, inside the same draft.
  assert.ok(rewrite.indexOf("shopifyRemoveDraftDiscount") < rewrite.indexOf("shopifyAddDraftDiscount"));
});

test("the renewal price check counts a leftover automatic copy as drift", () => {
  const check = readFileSync(join(__dirname, "shopcx-renewal-price-check.ts"), "utf8");
  assert.match(check, /const actual = current \* qty - l\.structuralDiscountCents - l\.automaticDiscountCents;/);
});

test("an inert automatic on the contract cannot double-count with our own discount", () => {
  // Both entities coexist after normalization (Buy 2 AUTOMATIC + our Volume discount MANUAL), and
  // the line still nets $96.54 because the automatic allocates $0. `structuralDiscountCents` counts
  // only allocations carrying OUR titles, so the arithmetic cannot pick the automatic up.
  const client = readFileSync(join(__dirname, "shopify-subscription-client.ts"), "utf8");
  assert.match(client, /STRUCTURAL_DISCOUNT_TITLES\.includes\(String\(a\?\.discount\?\.title \?\? ""\)\)/);
});

// ── Wiring: the normalizer must actually run on a newly-ingested checkout contract ──
// It shipped with no caller, so every PDP contract would have kept the plan-baked price and lost
// its quantity break from the first renewal on.
const INGEST = readFileSync(join(__dirname, "..", "inngest", "shopcx-contract-ingest.ts"), "utf8");
const ingestFn = INGEST.slice(INGEST.indexOf("export const shopcxContractIngest"), INGEST.indexOf("export const shopcxContractSync"));
const syncFn = INGEST.slice(INGEST.indexOf("export const shopcxContractSync"));

test("the create-ingest normalizes a contract it just ingested, after the ingest step", () => {
  const ingestAt = ingestFn.indexOf('step.run("ingest"');
  const normalizeAt = ingestFn.indexOf("shopcxNormalizeNewContract(");
  assert.ok(ingestAt > 0 && normalizeAt > ingestAt, "normalize must run after the row exists");
  assert.match(ingestFn, /result\.ingested\s*\?\s*await step\.run\("normalize-pricing"/,
    "only an ingested contract is normalized — a claimed (migrated / one-time) contract is not ours to reprice");
});

test("the update-sync never normalizes", () => {
  // A line pinned below MSRP on purpose (agent price restore) carries no allocation either; running
  // the normalizer on every contract update would silently undo the pin.
  assert.doesNotMatch(syncFn, /shopcxNormalizeNewContract/);
});
