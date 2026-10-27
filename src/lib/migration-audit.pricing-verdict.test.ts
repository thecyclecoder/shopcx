/**
 * judgePricingPreserved — the two pricing_preserved shapes the migration-fix agent diagnosed as
 * permanent false failures (lost diagnoses #1, #3, #6, #9, #10), plus the guard rails that must
 * still fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { judgePricingPreserved, itemSetKey, appstleContractGone } from "./migration-audit";

const base = { tol: 4, allProductLinesStandard: true, itemsChangedSinceMigration: false };

test("exact match → ok", () => {
  assert.deepEqual(judgePricingPreserved({ ...base, pre: 11992, noBreakCents: 11992 }), { ok: true, reason: "match" });
});

test("C: Appstle baseline already carried a qty/volume break — pre BELOW no-break 11992 but MATCHES with-break engine 8992 (f2d0f1bf) → preserved", () => {
  assert.deepEqual(
    judgePricingPreserved({ ...base, pre: 8992, engineCents: 8992, noBreakCents: 11992 }),
    { ok: true, reason: "match_with_break" },
  );
});

test("still FAILS when underpriced beyond the legit break (pre 8000 matches neither no-break 11992 nor with-break 8992)", () => {
  assert.equal(judgePricingPreserved({ ...base, pre: 8000, engineCents: 8992, noBreakCents: 11992 }).ok, false);
});

test("still FAILS when engine would charge MORE than the Appstle pre (pre 8500 < with-break 8992, over tol)", () => {
  assert.equal(judgePricingPreserved({ ...base, pre: 8500, engineCents: 8992, noBreakCents: 11992 }).ok, false);
});

test("Appstle 404 → contract gone (cancelled check passes)", () => {
  assert.equal(appstleContractGone(404), true);
});

test("Appstle 400 → contract gone too — a migrated-away external id no longer resolves (f2d0f1bf)", () => {
  assert.equal(appstleContractGone(400), true);
});

test("Appstle 200 / 5xx → NOT 'gone' — must read the contract status, not assume cancelled", () => {
  assert.equal(appstleContractGone(200), false);
  assert.equal(appstleContractGone(500), false);
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
