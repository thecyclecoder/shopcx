/**
 * Phase 2 of subscription-renewal-honors-configured-grandfathered-price-never-
 * bills-standard.
 *
 * Pins the invariant this phase adds at the pre-charge junction of the
 * internal renewal path:
 *
 *   1. Computed unit ≤ configured ceiling (price_cents lock) → guard passes.
 *   2. Computed unit > configured ceiling (price_cents lock)  → guard fails
 *      with reason 'overcharge_above_configured' + the offending line reported.
 *   3. price_override_cents (pre-discount base) works as the ceiling when
 *      price_cents is not set — engine's unit ≤ base is fine; > base fails.
 *   4. Item with neither lock is uncapped (opt-in to live catalog) — never
 *      surfaces as an offending line regardless of the computed amount.
 *   5. Gifts + shipping protection never contribute to the guard (unit $0 by
 *      design / flag-billed, no ceiling).
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-renewal-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkRenewalOverchargeGuard } from "./subscription-renewal-guard";

const V1 = "22222222-2222-2222-2222-222222222222";
const V2 = "33333333-3333-3333-3333-333333333333";
const GIFT = "44444444-4444-4444-4444-444444444444";
const PROT = "55555555-5555-5555-5555-555555555555";

test("Phase 2: computed unit AT the configured price_cents ceiling passes the guard", () => {
  const items = [{ variant_id: V1, quantity: 1, price_cents: 3995 }];
  const lines = [{ variant_id: V1, quantity: 1, unit_cents: 3995, kind: "product" as const }];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, true);
  assert.equal(r.offending_lines.length, 0);
  assert.equal(r.computed_product_cents, 3995);
  assert.equal(r.configured_cap_cents, 3995);
});

test("Phase 2: computed unit ABOVE the configured price_cents ceiling FAILS — this is the exact ticket shape (locked $39.95, engine tried $46.17)", () => {
  const items = [{ variant_id: V1, quantity: 1, price_cents: 3995 }];
  const lines = [{ variant_id: V1, quantity: 1, unit_cents: 4617, kind: "product" as const }];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, false, "guard must fail");
  assert.equal(r.reason, "overcharge_above_configured");
  assert.equal(r.offending_lines.length, 1);
  assert.deepEqual(r.offending_lines[0], {
    variant_id: V1,
    quantity: 1,
    computed_unit_cents: 4617,
    configured_ceiling_cents: 3995,
  });
});

test("Phase 2: price_override_cents (pre-discount base) is the ceiling when price_cents is unset — engine unit ≤ base passes", () => {
  const items = [{ variant_id: V1, quantity: 2, price_override_cents: 5327 }];
  const lines = [{ variant_id: V1, quantity: 2, unit_cents: 3995, kind: "product" as const }];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, true);
  assert.equal(r.configured_cap_cents, 5327 * 2);
});

test("Phase 2: price_override_cents ceiling fails when the engine's unit exceeds the base (repricing bug fail-safe)", () => {
  const items = [{ variant_id: V1, quantity: 1, price_override_cents: 5327 }];
  const lines = [{ variant_id: V1, quantity: 1, unit_cents: 6100, kind: "product" as const }];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, false);
  assert.equal(r.offending_lines[0].configured_ceiling_cents, 5327);
});

test("Phase 2: item with NO lock (no price_cents, no override) is uncapped — never an offending line, contributes to computed but not cap", () => {
  const items = [
    { variant_id: V1, quantity: 1 }, // uncapped
    { variant_id: V2, quantity: 3, price_cents: 2000 }, // capped
  ];
  const lines = [
    { variant_id: V1, quantity: 1, unit_cents: 9999, kind: "product" as const },
    { variant_id: V2, quantity: 3, unit_cents: 2000, kind: "product" as const },
  ];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, true, "uncapped line can't offend");
  assert.equal(r.configured_cap_cents, 2000 * 3);
  assert.equal(r.computed_product_cents, 9999 + 2000 * 3);
});

test("Phase 2: gifts + shipping protection never contribute — ceiling ignored on gifts, protection line's kind excluded", () => {
  const items = [
    { variant_id: V1, quantity: 1, price_cents: 3995 },
    { variant_id: GIFT, quantity: 1, is_gift: true, price_cents: 1 }, // ceiling set but is_gift ignores it
    { variant_id: PROT, quantity: 1, price_cents: 200 }, // protection line — kind excludes it below
  ];
  const lines = [
    { variant_id: V1, quantity: 1, unit_cents: 3995, kind: "product" as const },
    { variant_id: GIFT, quantity: 1, unit_cents: 0, kind: "gift" as const },
    { variant_id: PROT, quantity: 1, unit_cents: 200, kind: "protection" as const },
  ];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, true);
  assert.equal(r.computed_product_cents, 3995, "protection + gift excluded from computed");
  assert.equal(r.configured_cap_cents, 3995, "protection + gift excluded from cap");
});

test("Phase 2: multi-line — one line offends, one is fine → guard fails with only the offending line reported", () => {
  const items = [
    { variant_id: V1, quantity: 1, price_cents: 3995 },
    { variant_id: V2, quantity: 2, price_cents: 2000 },
  ];
  const lines = [
    { variant_id: V1, quantity: 1, unit_cents: 3995, kind: "product" as const },
    { variant_id: V2, quantity: 2, unit_cents: 2500, kind: "product" as const }, // offends
  ];
  const r = checkRenewalOverchargeGuard(items, lines);
  assert.equal(r.ok, false);
  assert.equal(r.offending_lines.length, 1);
  assert.equal(r.offending_lines[0].variant_id, V2);
});
