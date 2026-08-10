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
  packingSlipFirstName,
  RECONCILE_ELIGIBLE_SOURCE_NAMES,
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
