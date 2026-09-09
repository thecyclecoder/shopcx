/**
 * Pins the four dunning decisions that were live defects in the week of 2026-09-09.
 *
 * Every case here is a real failure, not a hypothetical — and every one was invisible for
 * months because the decision lived inline inside an Inngest step that no test could reach.
 * The shared shape of all four: a guard that LOOKED present but could never fire, so the
 * system degraded silently rather than erroring.
 *
 * Run: npx tsx --test src/lib/dunning.decisions.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isOpenDunningStatus,
  shouldHaltRetryForSubStatus,
  shouldExhaustForRetryCap,
  resolveCycleAction,
  OPEN_DUNNING_STATUSES,
  ACTIVE_SLOT_STATUSES,
  holdsActiveCycleSlot,
} from "./dunning";

const MAX_PAYDAY_RETRIES = 4;
const SETTINGS = { dunning_cycle_1_action: "skip", dunning_cycle_2_action: "cancel" };

// ── the retry cap ──────────────────────────────────────────────────────────────────────

test("retry cap: a hardcoded attempt_number of 0 must never read as 'cap reached'", () => {
  // The cron logged EVERY payday retry with `attemptNumber: 0`, so any count-based guard was
  // dead code — `0 > 4` is never true. 17,729 of 17,949 retries carried 0.
  assert.equal(shouldExhaustForRetryCap(0, MAX_PAYDAY_RETRIES), false);
});

test("retry cap: null/undefined count reads as 0, not as exhausted", () => {
  // A fresh cycle predates the column. Reading null as "capped" would exhaust every new
  // cycle on its first tick and never retry anyone.
  assert.equal(shouldExhaustForRetryCap(null, MAX_PAYDAY_RETRIES), false);
  assert.equal(shouldExhaustForRetryCap(undefined, MAX_PAYDAY_RETRIES), false);
});

test("retry cap: fires AT the max, not one past it", () => {
  // Off-by-one here is the difference between 4 retries and 5. The seeded cohort sat at 3
  // precisely so it would take exactly one more attempt before exhausting.
  assert.equal(shouldExhaustForRetryCap(3, MAX_PAYDAY_RETRIES), false, "3 of 4 — one left");
  assert.equal(shouldExhaustForRetryCap(4, MAX_PAYDAY_RETRIES), true, "4 of 4 — done");
});

test("retry cap: a runaway count still exhausts (192 attempts on one cycle)", () => {
  // Ground truth: cycle 910acc09 reached 192 payday retries between 2026-04-17 and 09-04
  // because the cap could never fire.
  assert.equal(shouldExhaustForRetryCap(192, MAX_PAYDAY_RETRIES), true);
});

// ── the subscription-state halt ────────────────────────────────────────────────────────

test("halt: a customer-PAUSED sub must not be retried", () => {
  // The guard checked only "cancelled", so paused subs kept being billed. Four were about to
  // be emailed "your payment failed" for a subscription they had paused — one until 2026-10-30.
  assert.equal(shouldHaltRetryForSubStatus("paused"), true);
});

test("halt: a cancelled sub must not be retried", () => {
  assert.equal(shouldHaltRetryForSubStatus("cancelled"), true);
});

test("halt: a missing subscription must not be retried", () => {
  // A deleted/unreadable sub must fail CLOSED — retrying a sub we cannot read is how you
  // charge someone with no way to see what you charged them for.
  assert.equal(shouldHaltRetryForSubStatus(null), true);
  assert.equal(shouldHaltRetryForSubStatus(undefined), true);
});

test("halt: an ACTIVE sub is still retried", () => {
  // The guard must not over-reach — 408 live cycles are on active subs and must keep dunning.
  assert.equal(shouldHaltRetryForSubStatus("active"), false);
});

// ── the cycle ladder ───────────────────────────────────────────────────────────────────

test("ladder: cycle 1 gets the gentle action, cycle 2+ the hard one", () => {
  assert.equal(resolveCycleAction(1, SETTINGS), "skip");
  assert.equal(resolveCycleAction(2, SETTINGS), "cancel");
  assert.equal(resolveCycleAction(3, SETTINGS), "cancel", "3+ stays on the cycle-2 action");
});

test("ladder: a null cycle_number falls back to cycle 1, never to cancel", () => {
  // Failing open to "cancel" would terminate subscriptions on a missing column. The gentle
  // branch is the safe default.
  assert.equal(resolveCycleAction(null, SETTINGS), "skip");
  assert.equal(resolveCycleAction(undefined, SETTINGS), "skip");
});

test("ladder: honours whatever the workspace configures, not hardcoded verbs", () => {
  // cycle_2_action is 'cancel' for Superfoods but 'pause' is a valid setting; the brain
  // documented 'pause' while the DB said 'cancel', so this must read settings, not prose.
  const paused = { dunning_cycle_1_action: "pause", dunning_cycle_2_action: "pause" };
  assert.equal(resolveCycleAction(1, paused), "pause");
  assert.equal(resolveCycleAction(2, paused), "pause");
});

// ── open-cycle classification (what a pause/cancel closes) ─────────────────────────────

test("open cycles: every in-flight state is closable by a sub pause/cancel", () => {
  for (const s of OPEN_DUNNING_STATUSES) {
    assert.equal(isOpenDunningStatus(s), true, `${s} should be closable`);
  }
});

test("open cycles: an EXHAUSTED cycle is NOT closed — that would break reactivation", () => {
  // dunning-new-card-recovery deliberately includes `exhausted` so a DUNNING-cancelled sub
  // reactivates when the customer adds a card (Phase 5, fixed 2026-06-09). Closing those
  // would silently remove that path. This is the load-bearing exclusion.
  assert.equal(isOpenDunningStatus("exhausted"), false);
});

test("open cycles: a RECOVERED cycle is not reopened or reclosed", () => {
  assert.equal(isOpenDunningStatus("recovered"), false);
});

test("open cycles: an unknown or absent status is not treated as open", () => {
  assert.equal(isOpenDunningStatus(null), false);
  assert.equal(isOpenDunningStatus(undefined), false);
  assert.equal(isOpenDunningStatus("nonsense"), false);
});

// ── the active-cycle slot (what a terminal status must NOT hold) ────────────────────────
//
// Added after a code review caught three regressions the cases above did not: the payday
// exhaustion path was leaving cycle-1 rows in `status='skipped'`, which still holds the
// partial-unique slot, so those subscriptions could never open another dunning cycle.

test("slot: 'skipped' HOLDS the active-cycle slot — a terminal status must never be it", () => {
  // The trap. handleAllCardsExhausted's skip branch writes 'skipped'; that is safe on the
  // card-rotation path (step 7 flips it back to 'retrying') and fatal on the payday path,
  // where nothing flips it and the cron never re-selects it.
  assert.equal(holdsActiveCycleSlot("skipped"), true);
});

test("slot: 'exhausted' does NOT hold the slot — the only safe payday terminal", () => {
  assert.equal(holdsActiveCycleSlot("exhausted"), false);
  assert.equal(holdsActiveCycleSlot("recovered"), false);
});

test("slot: the set matches the DB partial unique index exactly", () => {
  // idx_dunning_cycles_active_contract: WHERE status IN ('active','skipped','paused').
  // Drifting from it silently reintroduces the duplicate-cycle block.
  assert.deepEqual([...ACTIVE_SLOT_STATUSES].sort(), ["active", "paused", "skipped"]);
});

test("open cycles: 'paused' IS open — it must be closable by a sub pause/cancel", () => {
  // Omitted from OPEN_DUNNING_STATUSES originally, so a paused CYCLE was never closed:
  // it still reached new-card-recovery (→ resume + charge) and still held the slot with no
  // way to clear it. Nothing writes 'paused' today, but legacy rows retain it.
  assert.equal(isOpenDunningStatus("paused"), true);
});
