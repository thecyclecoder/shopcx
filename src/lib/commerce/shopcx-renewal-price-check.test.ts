/**
 * The ShopCX renewal pricing check is LOG-ONLY (CEO 2026-10-10). These pin the two properties that
 * make it safe to run in front of every charge: it ignores rounding noise, and it can never stop,
 * delay or alter the charge that follows it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMaterialGap } from "./shopcx-renewal-price-check";

test("a gap at or under $1 / 2% is noise", () => {
  assert.equal(isMaterialGap(5247, 5247), false);
  assert.equal(isMaterialGap(5247, 5347), false); // exactly $1.00
  assert.equal(isMaterialGap(20000, 20400), false); // exactly 2% of $200
});

test("a missing S&S or tier is material, in either direction", () => {
  assert.equal(isMaterialGap(5247, 6995), true); // real: test contract 35917070509, S&S never applied
  assert.equal(isMaterialGap(10494, 9655), true); // tier applied twice
});

const SRC = readFileSync(join(__dirname, "shopcx-renewal-price-check.ts"), "utf8");
const RENEWALS = readFileSync(join(__dirname, "..", "inngest", "shopify-subscription-renewals.ts"), "utf8");

test("the check never throws — a failure reads as unchecked", () => {
  const fn = SRC.slice(SRC.indexOf("export async function checkShopcxRenewalPrice"), SRC.indexOf("export async function surfaceRenewalPriceMismatch"));
  assert.match(fn, /catch \(err\) \{\s*return \{ status: "unchecked"/);
});

test("the renewal runs the check before charging and nothing branches on its result", () => {
  const checkAt = RENEWALS.indexOf('step.run("price-check-log"');
  const chargeAt = RENEWALS.indexOf('step.run("attempt-billing"');
  assert.ok(checkAt > 0 && checkAt < chargeAt);
  // The step's return value is discarded: no `const x = await step.run("price-check-log"`.
  assert.doesNotMatch(RENEWALS, /=\s*await step\.run\("price-check-log"/);
});
