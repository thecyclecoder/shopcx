/**
 * immediate_charge_false_failures Phase 1 — pins the `immediateChargeIsSoleFailure`
 * predicate the backfill uses to decide which failed audit rows are eligible for a
 * false-positive reversal.
 *
 * GUARD-BEFORE-MUTATION (coaching #11 / #12 / #14): this predicate is the last
 * filter before a `.update({ status: 'passed' })` fan-out over historical audits;
 * getting it wrong would either miss a real false-positive (the whole point) OR —
 * far worse — flip a genuine renewal-at-risk row to `passed` and hide it from the
 * dashboard. So it must return true ONLY when `immediate_charge` is the sole failing
 * check; ANY other failing check keeps the row `failed` for human review.
 *
 *   npx tsx --test scripts/_backfill-migration-audit-immediate-charge-false-failures.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { immediateChargeIsSoleFailure } from "./_backfill-migration-audit-immediate-charge-false-failures";

test("immediate_charge sole failure → eligible", () => {
  const r = immediateChargeIsSoleFailure([
    { key: "is_internal", ok: true },
    { key: "items_on_uuids", ok: true },
    { key: "appstle_cancelled", ok: true },
    { key: "pricing_preserved", ok: true },
    { key: "card_pinned", ok: true },
    { key: "immediate_charge", ok: false, detail: "last renewal failed" },
    { key: "no_double_bill", ok: true },
  ]);
  assert.equal(r, true);
});

test("pricing_preserved ALSO failing → NOT eligible (genuine renewal-at-risk)", () => {
  const r = immediateChargeIsSoleFailure([
    { key: "immediate_charge", ok: false },
    { key: "pricing_preserved", ok: false, detail: "engine 6000 vs pre 6496" },
  ]);
  assert.equal(r, false);
});

test("card_pinned ALSO failing → NOT eligible (no billable card is a real problem)", () => {
  const r = immediateChargeIsSoleFailure([
    { key: "immediate_charge", ok: false },
    { key: "card_pinned", ok: false, detail: "no card in link group" },
  ]);
  assert.equal(r, false);
});

test("no failing checks at all → NOT eligible (row shouldn't be `failed` in the first place)", () => {
  const r = immediateChargeIsSoleFailure([
    { key: "is_internal", ok: true },
    { key: "immediate_charge", ok: true },
  ]);
  assert.equal(r, false);
});

test("empty checks array → NOT eligible", () => {
  assert.equal(immediateChargeIsSoleFailure([]), false);
});

test("some OTHER check is failing but immediate_charge is passing → NOT eligible", () => {
  const r = immediateChargeIsSoleFailure([
    { key: "appstle_cancelled", ok: false, detail: "appstle status ACTIVE" },
    { key: "immediate_charge", ok: true },
  ]);
  assert.equal(r, false);
});
