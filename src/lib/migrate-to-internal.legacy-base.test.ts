/**
 * The ShopCX → internal base conversion must keep the Legacy-rate concession whole once the
 * internal engine re-applies S&S / volume to the base (2026-11-02 review: an un-grossed
 * concession shrank by that fraction every cycle).
 *
 * Run: npm run test:migrate-to-internal-legacy-base
 */
import test from "node:test";
import assert from "node:assert/strict";
import { internalBaseFromShopcxLine } from "./migrate-to-internal";
import { shopcxSkipTargetDate } from "./commerce/subscription";

test("legacy rate is grossed up so S&S on the new base lands on the same price", () => {
  // $79.95 MSRP, S&S 25% ($19.99), Legacy rate $18.00 → pays $41.96.
  const base = internalBaseFromShopcxLine(7995, 1, 1999 + 1800, 1800);
  assert.equal(Math.round(base * 0.75), 7995 - 1999 - 1800 + 0);
});

test("quantity 2 with S&S 25% + volume 8%", () => {
  const gross = 7995 * 2;
  const structural = Math.round(gross * (1 - 0.75 * 0.92)); // S&S + volume, compounded
  const legacy = 1000; // $5.00 a unit
  const base = internalBaseFromShopcxLine(7995, 2, structural + legacy, legacy);
  const internalPays = Math.round(base * 0.75 * 0.92) * 2;
  assert.ok(Math.abs(internalPays - (gross - structural - legacy)) <= 2, `${internalPays} vs ${gross - structural - legacy}`);
});

test("no legacy rate → base unchanged", () => {
  assert.equal(internalBaseFromShopcxLine(7995, 1, 1999, 0), 7995);
});

test("skip moves the planned date one cadence, billing day kept", () => {
  assert.equal(shopcxSkipTargetDate("2026-11-15T12:00:00.000Z", "month", 1), "2026-12-15T12:00:00.000Z");
  assert.equal(shopcxSkipTargetDate("2026-11-15T12:00:00.000Z", "MONTH", 2), "2027-01-15T12:00:00.000Z");
  assert.equal(shopcxSkipTargetDate("2026-11-15T12:00:00.000Z", "week", 2), "2026-11-29T12:00:00.000Z");
});
