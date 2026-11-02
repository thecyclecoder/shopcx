/**
 * ShopCX dunning charges: which card Shopify actually sees, which cycle it bills, and when to stop.
 *
 *  - F6: every card in a payday pass shares one ordinal. Without the card in the idempotency key,
 *    card B replayed card A's cached decline, so backup cards were never presented.
 *  - F6: an unresolved attempt stops rotation and is read back before the next payday pass, so a
 *    slow success is never followed by a second charge.
 *  - F7: dunning addresses the cycle BY INDEX with an in-window origin time (the renewal worker's
 *    shape), never by date — by-date failed on a BILLED or out-of-window cycle and burned the
 *    ladder without ever charging.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  shopcxDunningIdempotencyKey,
  shouldRefuseEarlyDunningCharge,
  classifyPriorAttempt,
} from "./dunning-charge";

// ── F6: per-card idempotency ───────────────────────────────────────────────────

test("F6: two cards in the same payday pass get different Shopify keys", () => {
  const a = shopcxDunningIdempotencyKey("36100000001", "2026-11-10T15:00:00Z", 2, "4242-12-2027");
  const b = shopcxDunningIdempotencyKey("36100000001", "2026-11-10T15:00:00Z", 2, "5555-01-2028");
  assert.notEqual(a, b, "a shared key makes Shopify replay card A's decline for card B");
  assert.equal(a, "36100000001:2026-11-10:r2:4242-12-2027");
});

test("F6: a step retry for the same card rebuilds the SAME key (no second real charge)", () => {
  const first = shopcxDunningIdempotencyKey("36100000001", "2026-11-10T15:00:00Z", 2, "4242-12-2027");
  const retry = shopcxDunningIdempotencyKey("36100000001", "2026-11-10T15:00:00Z", 2, "4242-12-2027");
  assert.equal(first, retry);
});

test("F6: rotation (one card per ordinal) keeps the historical key shape", () => {
  assert.equal(shopcxDunningIdempotencyKey("36100000001", "2026-11-10T15:00:00Z", 1), "36100000001:2026-11-10:r1");
});

test("F6: the payday call passes the card's dedupeKey", () => {
  const SRC = readFileSync(join(__dirname, "inngest", "dunning.ts"), "utf8");
  assert.match(
    SRC,
    /dunningChargeContract\(cycle\.workspace_id, cycle\.shopify_contract_id, \(cycle\.payday_retry_count \?\? 0\) \+ 1, card\.dedupeKey\)/,
  );
});

test("F6: rotation stops on an unresolved attempt and records it", () => {
  const SRC = readFileSync(join(__dirname, "inngest", "dunning.ts"), "utf8");
  const pending = SRC.slice(SRC.indexOf("if (billingRes.pending) {"), SRC.indexOf("// ⚠️ A LOOKUP miss is not a decline."));
  assert.match(pending, /billing_attempt_id: attemptId/);
  assert.match(pending, /return "pending" as const;/);
  assert.match(SRC, /if \(rotation === "pending"\) break;/);
});

test("F6: the payday pass reads the prior attempt before presenting any card", () => {
  const SRC = readFileSync(join(__dirname, "inngest", "dunning.ts"), "utf8");
  const payday = SRC.slice(SRC.indexOf('id: "dunning-payday-retry-cron"'));
  const read = payday.indexOf("priorShopcxAttemptOutcome(cycle.workspace_id, cycle.billing_attempt_id)");
  const loop = payday.indexOf("for (const card of paymentMethods)");
  assert.ok(read > 0 && loop > read, "the read must come before the card loop");
  assert.match(payday.slice(loop, loop + 120), /if \(prior !== "clear"\) break;/);
});

test("F6: a prior attempt that settled as a charge means recovered, never another card", () => {
  assert.equal(classifyPriorAttempt({ success: true, terminal: true, pending: false }), "succeeded");
});

test("F6: a still-pending or unreadable prior attempt presents no card", () => {
  assert.equal(classifyPriorAttempt({ success: false, terminal: false, pending: true }), "unresolved");
  assert.equal(classifyPriorAttempt({ success: false }), "unresolved");
});

test("F6: a settled decline (or no attempt on record) retries as normal", () => {
  assert.equal(classifyPriorAttempt({ success: false, terminal: true, pending: false }), "clear");
  assert.equal(classifyPriorAttempt(null), "clear");
});

// ── F7: by-index addressing ────────────────────────────────────────────────────

const SHOPCX = (() => {
  const SRC = readFileSync(join(__dirname, "dunning-charge.ts"), "utf8");
  const start = SRC.indexOf('if (src === "shopcx")');
  return SRC.slice(start, SRC.indexOf("// Appstle / internal:", start));
})();

test("F7: the shopcx dunning charge resolves the cycle by index with an origin time", () => {
  assert.match(SHOPCX, /resolveChargeableCycle\(workspaceId, contractId, new Date\(\)\)/);
  assert.match(SHOPCX, /billingCycleSelector: \{ index: cycle\.index \}, originTime: cycle\.originTime/);
  assert.doesNotMatch(SHOPCX, /billingCycleSelector: \{ date: due \}/, "by-date addressing is the bug");
});

test("F7: an unresolvable cycle returns no attempt id (not a decline)", () => {
  const miss = SHOPCX.slice(SHOPCX.indexOf("if (!cycle.success"), SHOPCX.indexOf("if (!cycle.success") + 200);
  assert.match(miss, /return \{ success: false, engine, error: cycle\.error \?\? "no chargeable cycle" \}/);
  assert.doesNotMatch(miss, /attemptId/);
});

test("F7: by index never bills the NEXT order early once the cycle was paid elsewhere", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  // Order Now paid the declined cycle and advanced our date a cadence out; Shopify's only unbilled
  // cycle is the future one.
  assert.equal(shouldRefuseEarlyDunningCharge("2026-12-10T15:00:00Z", false, now), true);
});

test("F7: a held (past or today) date still retries, even against a future cycle", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assert.equal(shouldRefuseEarlyDunningCharge("2026-11-10T15:00:00Z", false, now), false);
  assert.equal(shouldRefuseEarlyDunningCharge("2026-11-12T23:00:00Z", false, now), false, "due later today");
});

test("F7: an open, unbilled current cycle still retries even when our date was set forward", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assert.equal(shouldRefuseEarlyDunningCharge("2026-11-13T10:00:00Z", true, now), false);
});

test("F7: no date keeps the old behaviour (no refusal)", () => {
  assert.equal(shouldRefuseEarlyDunningCharge(null, false), false);
});
