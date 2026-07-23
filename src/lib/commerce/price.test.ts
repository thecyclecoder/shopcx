/**
 * Unit tests for resolveProtectionCents — the comp-sub shipping-protection rule.
 *   npx tsx --test src/lib/commerce/price.test.ts
 *
 * A comp (free) sub charges $0; its portal summary must not show a $4.95
 * protection line (or a $4.95 total) the customer is never billed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProtectionCents } from "./price";

test("comp sub → $0 protection even when protection is 'added'", () => {
  assert.equal(
    resolveProtectionCents({ comp: true, shipping_protection_added: true, shipping_protection_amount_cents: 495 }),
    0,
  );
});

test("non-comp sub with protection added → the protection amount", () => {
  assert.equal(
    resolveProtectionCents({ comp: false, shipping_protection_added: true, shipping_protection_amount_cents: 495 }),
    495,
  );
});

test("non-comp sub without protection → $0", () => {
  assert.equal(
    resolveProtectionCents({ comp: false, shipping_protection_added: false, shipping_protection_amount_cents: 495 }),
    0,
  );
});

test("comp defaults undefined → treated as non-comp (added amount)", () => {
  assert.equal(
    resolveProtectionCents({ shipping_protection_added: true, shipping_protection_amount_cents: 300 }),
    300,
  );
});
