/**
 * Phase 2 of internal-renewal-shipping-address-carries-the-customer-name.
 *
 * Pins the invariant this phase adds inside `reconcileOne` (via the pure
 * `isReconcileEligibleSourceName` helper it now delegates to) and inside the
 * packing-slip note builder (via `packingSlipFirstName`):
 *   - internal_subscription_renewal is retried (was skipped forever)
 *   - storefront is still retried
 *   - other sources (comp $0 markers, external imports) are still skipped
 *   - the packing-slip greeting reads both first_name (snake) and firstName
 *     (camel), so an internal renewal doesn't silently lose the name on
 *     retry (internal writes camel; storefront legacy writes snake)
 *
 * Pure functions, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/amplifier-import-reconcile.eligibility.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isReconcileEligibleSourceName,
  isShopifyOriginOrder,
  isShopifyRenewalSourceName,
  packingSlipFirstName,
  shopifyRenewalStuckWindow,
  RECONCILE_ELIGIBLE_SOURCE_NAMES,
  SHOPIFY_RENEWAL_SOURCE_NAMES,
  SHOPIFY_RENEWAL_WINDOW_DAYS,
  SHOPIFY_RENEWAL_STUCK_HOURS,
} from "./amplifier-import-reconcile";

test("Phase 2: internal_subscription_renewal is now eligible for reconcile retries (was skipped forever)", () => {
  assert.equal(isReconcileEligibleSourceName("internal_subscription_renewal"), true);
});

test("Phase 2: storefront eligibility is preserved (the original scope)", () => {
  assert.equal(isReconcileEligibleSourceName("storefront"), true);
});

test("Phase 2: comp $0 marker orders are NOT eligible — they don't ship physical product through Amplifier", () => {
  assert.equal(isReconcileEligibleSourceName("internal_subscription_comp_renewal"), false);
});

test("Phase 2: an unknown source name is NOT eligible (safety default — never retry an import we don't understand)", () => {
  assert.equal(isReconcileEligibleSourceName("shopify_import_backfill"), false);
  assert.equal(isReconcileEligibleSourceName(""), false);
  assert.equal(isReconcileEligibleSourceName(null), false);
  assert.equal(isReconcileEligibleSourceName(undefined), false);
});

test("Phase 2: the eligible set exposes exactly the two allowed source names (guards accidental drift)", () => {
  assert.deepEqual([...RECONCILE_ELIGIBLE_SOURCE_NAMES].sort(), [
    "internal_subscription_renewal",
    "storefront",
  ]);
});

test("head-of-line guard: a Shopify-origin (SC*) order is never this rail's business", () => {
  assert.equal(isShopifyOriginOrder({ shopify_order_id: "5551234567890" }), true);
});

test("head-of-line guard: an internal (SHOPCX*) order IS this rail's business", () => {
  assert.equal(isShopifyOriginOrder({ shopify_order_id: null }), false);
});

test("head-of-line guard: a missing shopify_order_id key is treated as internal, not Shopify", () => {
  // A narrowed .select() that omits the column must not silently reclassify
  // every internal order as Shopify and re-stall the rail.
  assert.equal(isShopifyOriginOrder({}), false);
  assert.equal(isShopifyOriginOrder({ shopify_order_id: undefined }), false);
});

test("head-of-line guard: any non-null id counts as Shopify-origin regardless of type", () => {
  // shopify_order_id is text in the DB but historical rows / callers have
  // passed numerics; both must classify as Shopify.
  assert.equal(isShopifyOriginOrder({ shopify_order_id: 5551234567890 }), true);
  assert.equal(isShopifyOriginOrder({ shopify_order_id: "" }), true);
});

test("Phase 2: packing-slip greeting reads first_name (snake_case — storefront legacy shape)", () => {
  assert.equal(packingSlipFirstName({ first_name: "Shannon" }), "Shannon");
});

test("Phase 2: packing-slip greeting reads firstName (camelCase — internal renewal shape)", () => {
  assert.equal(packingSlipFirstName({ firstName: "Shannon" }), "Shannon");
});

test("Phase 2: snake_case wins when both are present (matches historical behavior for storefront rows)", () => {
  assert.equal(packingSlipFirstName({ first_name: "Legacy", firstName: "New" }), "Legacy");
});

test("Phase 2: packing-slip greeting returns empty string when neither casing has a name (no crash, no stray undefined)", () => {
  assert.equal(packingSlipFirstName({}), "");
  assert.equal(packingSlipFirstName(null), "");
  assert.equal(packingSlipFirstName(undefined), "");
});

test("Phase 2: non-string values on the address are ignored (defensive — never pass a number/object to the greeting)", () => {
  const ship = { first_name: 42, firstName: { rogue: true } } as unknown as { first_name?: unknown; firstName?: unknown };
  assert.equal(packingSlipFirstName(ship), "");
});

// ── Shopify-origin subscription-renewal stuck-import escalation ──────────────
// Ticket 277c10ec: SC140881 (source_name 'subscription_contract_checkout_one')
// sat paid + un-imported to Amplifier for 3+ days with amplifier_import_attempts=0,
// amplifier_last_error null — the internal reconcile rail excludes it
// (shopify_order_id is SET) AND its source_name isn't a RECONCILE_ELIGIBLE one, so
// it had NO retry, NO stamped attempt/error, and NO CEO alert. This escalation
// closes the observability gap without re-matching the ~125k legacy SC* rows.

test("Shopify-renewal escalation: 'subscription_contract_checkout_one' is the discriminator that separates Amplifier-bound Shopify renewals from the 125k legacy SC* rows", () => {
  assert.equal(isShopifyRenewalSourceName("subscription_contract_checkout_one"), true);
});

test("Shopify-renewal escalation: an internal renewal is NOT a Shopify-renewal (it's the internal rail's business, caught by the shopify_order_id IS NULL sweep)", () => {
  assert.equal(isShopifyRenewalSourceName("internal_subscription_renewal"), false);
  assert.equal(isShopifyRenewalSourceName("storefront"), false);
});

test("Shopify-renewal escalation: an unknown / empty source name is never escalated as a Shopify renewal (safety default)", () => {
  assert.equal(isShopifyRenewalSourceName("shopify_import_backfill"), false);
  assert.equal(isShopifyRenewalSourceName(""), false);
  assert.equal(isShopifyRenewalSourceName(null), false);
  assert.equal(isShopifyRenewalSourceName(undefined), false);
});

test("Shopify-renewal escalation: the eligible set exposes exactly the one Shopify-origin renewal source (guards accidental drift)", () => {
  assert.deepEqual([...SHOPIFY_RENEWAL_SOURCE_NAMES].sort(), ["subscription_contract_checkout_one"]);
});

test("Shopify-renewal escalation: the window is a RECENT, bounded slice — never reaches 2024 legacy SC* rows", () => {
  // Fixed 'now' = 2026-10-23T00:00:00Z. The floor must be weeks ago, not years,
  // so the ~125k legacy SC* rows (2024) can never match; the SLA ceiling must be
  // comfortably past any transient checkout-import flake.
  const nowMs = Date.parse("2026-10-23T00:00:00.000Z");
  const { createdAfterIso, createdBeforeIso } = shopifyRenewalStuckWindow(nowMs);

  // Floor is exactly WINDOW_DAYS before now and is in 2026, nowhere near 2024.
  assert.equal(createdAfterIso, new Date(nowMs - SHOPIFY_RENEWAL_WINDOW_DAYS * 86_400_000).toISOString());
  assert.ok(Date.parse(createdAfterIso) > Date.parse("2025-01-01T00:00:00.000Z"), "floor must exclude legacy 2024 rows");

  // Ceiling is exactly STUCK_HOURS before now and strictly after the floor.
  assert.equal(createdBeforeIso, new Date(nowMs - SHOPIFY_RENEWAL_STUCK_HOURS * 3_600_000).toISOString());
  assert.ok(Date.parse(createdBeforeIso) > Date.parse(createdAfterIso), "SLA ceiling must sit inside the window");

  // SC140881 was paid 2026-10-20 — 3 days before this 'now' — so it falls inside
  // [floor, ceiling) and WOULD be escalated.
  const sc140881 = Date.parse("2026-10-20T00:00:00.000Z");
  assert.ok(sc140881 >= Date.parse(createdAfterIso) && sc140881 < Date.parse(createdBeforeIso), "the ticket's stuck order must land inside the escalation window");
});
