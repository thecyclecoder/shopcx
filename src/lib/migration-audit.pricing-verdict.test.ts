/**
 * judgePricingPreserved — the two pricing_preserved shapes the migration-fix agent diagnosed as
 * permanent false failures (lost diagnoses #1, #3, #6, #9, #10), plus the guard rails that must
 * still fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { judgePricingPreserved, itemSetKey } from "./migration-audit";

const base = { tol: 4, allProductLinesStandard: true, itemsChangedSinceMigration: false };

test("exact match → ok", () => {
  assert.deepEqual(judgePricingPreserved({ ...base, pre: 11992, noBreakCents: 11992 }), { ok: true, reason: "match" });
});

test("A: Appstle billed MSRP flat with no S&S (Jennifer 2670ab86: pre 15990, standard 11992) → moved to standard rate", () => {
  assert.deepEqual(judgePricingPreserved({ ...base, pre: 15990, noBreakCents: 11992 }), { ok: true, reason: "moved_to_standard_rate" });
});

test("A: base set before a catalog price drop (3bc592a8: pre 5990, standard 4492) → moved to standard rate", () => {
  assert.equal(judgePricingPreserved({ ...base, pre: 5990, noBreakCents: 4492 }).reason, "moved_to_standard_rate");
});

test("still FAILS when we would charge MORE than Appstle", () => {
  assert.deepEqual(judgePricingPreserved({ ...base, pre: 5996, noBreakCents: 8992 }), { ok: false, reason: "mismatch" });
});

test("still FAILS when a locked (grandfathered) line prices below Appstle", () => {
  assert.equal(judgePricingPreserved({ ...base, allProductLinesStandard: false, pre: 11990, noBreakCents: 9991 }).ok, false);
});

test("B: the customer changed items after migration → skipped as ok (e4ce: pre 10492 vs engine 2996)", () => {
  assert.deepEqual(
    judgePricingPreserved({ ...base, allProductLinesStandard: false, itemsChangedSinceMigration: true, pre: 10492, noBreakCents: 2996 }),
    { ok: true, reason: "items_changed" },
  );
});

test("no baseline (back-audit / cancelled fallback) → ok", () => {
  assert.equal(judgePricingPreserved({ ...base, pre: 0, noBreakCents: 5996 }).reason, "no_baseline");
});

test("itemSetKey is order-insensitive and quantity-aware", () => {
  assert.equal(itemSetKey([{ variant_id: "a", quantity: 1 }, { variant_id: "b", quantity: 2 }]), itemSetKey([{ variant_id: "b", quantity: 2 }, { variant_id: "a", quantity: 1 }]));
  assert.notEqual(itemSetKey([{ variant_id: "a", quantity: 1 }]), itemSetKey([{ variant_id: "a", quantity: 2 }]));
  assert.notEqual(itemSetKey([{ variant_id: "a", quantity: 1 }]), itemSetKey([{ variant_id: "b", quantity: 1 }]));
});
