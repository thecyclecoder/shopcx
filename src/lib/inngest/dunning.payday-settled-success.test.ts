/**
 * The payday retry must close the cycle on a SETTLED success, the same way card rotation does.
 *
 * A ShopCX charge settles inline and no webhook ever flips the cycle (`dunning/billing-success`
 * comes only from Appstle). Before this, the payday loop ignored the charge result, moved on to
 * the next card, and left the cycle `retrying`, so every later payday charged the customer again.
 * Ground truth 36063707309: recovered on the 2026-10-09 payday, charged again on 10-15, and queued
 * for a third charge on 10-16.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "dunning.ts"), "utf8");
const payday = SRC.slice(SRC.indexOf('id: "dunning-payday-retry-cron"'));
const loop = payday.slice(payday.indexOf("for (const card of paymentMethods)"), payday.indexOf("// Check final state"));

test("the payday loop acts on a settled success before trying another card", () => {
  const charge = loop.indexOf("dunningChargeContract(");
  const settled = loop.indexOf("paydayRes.settled && paydayRes.success");
  assert.ok(charge > -1 && settled > charge, "the settled-success check must follow the charge");
  const block = loop.slice(settled, loop.indexOf("break;", settled) + 6);
  assert.match(block, /status: "recovered"/);
  assert.match(block, /next_retry_at: null/);
  assert.match(block, /succeeded: true/);
  assert.match(block, /recovered = true/);
});

test("an unresolved (3DS) attempt stops the loop instead of charging the next card", () => {
  assert.match(loop, /if \(paydayRes\.pending\) \{[\s\S]*?break;/);
});
