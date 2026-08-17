/**
 * pax-never-reports-nothing-to-resolve-on-a-pr-state-it-could-not-read (Phase 1) — unit tests for the
 * pure decision helpers behind `runPrResolveJob`'s new unreadable-state branch. Ground truth: job
 * 5720fb3a completed in 27s with 'PR #2486 no longer open (state=undefined merged=undefined)' while
 * PR #2486 was OPEN + CONFLICTING; the fetch had failed and the ledger recorded a decisive terminal
 * verdict. These tests pin the "state=undefined must never read as closed" invariant at the counter /
 * classifier layer so no callsite can accidentally re-collapse the two.
 *
 *   npm run test:pr-resolve-unreadable-state-retry
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isUnreadablePrStateAttempt,
  countPriorUnreadablePrStateAttempts,
  countGenuinePrResolveAttempts,
  PR_RESOLVE_UNREADABLE_STATE_ERROR_PREFIX as PREFIX,
  PR_RESOLVE_MAX_UNREADABLE_STATE_ATTEMPTS_FOR_TESTS as MAX,
} from "./github-pr-resolve";

/** The exact retryable-failure shape `runPrResolveJob` writes on a 5xx GitHub read. */
const unreadableFailedHttp5xx = {
  status: "failed",
  error: `${PREFIX}: could not read PR #2486 state (HTTP 503: upstream connect error)`,
};
/** The 200-with-no-`state` case that job 5720fb3a hit — matches by prefix. */
const unreadableFailed200MissingState = {
  status: "failed",
  error: `${PREFIX}: could not read PR #2486 state (200 with state=undefined)`,
};
/** The cap-parked shape `runPrResolveJob` writes AFTER the consecutive-unreadable cap trips. */
const unreadableParked = {
  status: "needs_attention",
  error: `${PREFIX}: could not read PR #2486 state (HTTP 502)`,
};
/** A completed resolver run — always counts against the GENERAL cap; never against the unreadable one. */
const completedAttempt = { status: "completed", error: null };
/** An advisory-supersede park — counts against the GENERAL cap (it ran the resolver to a verdict). */
const advisorySupersedeParked = {
  status: "needs_attention",
  error: "advisory-supersede: 3 exported symbol(s) also appear on main",
};

test("MAX unreadable-state attempts is 3 (guard against constant drift)", () => {
  assert.equal(MAX, 3);
});

test("isUnreadablePrStateAttempt matches the retryable failed shape (5xx)", () => {
  assert.equal(isUnreadablePrStateAttempt(unreadableFailedHttp5xx), true);
});

test("isUnreadablePrStateAttempt matches the 200-with-missing-state shape — the #2486 signature", () => {
  // This is the invariant the spec pins: state=undefined must NOT read as closed. The counter
  // recognizes the 200/unknown-state row so a follow-up pass can retry it, then escalate on cap.
  assert.equal(isUnreadablePrStateAttempt(unreadableFailed200MissingState), true);
});

test("isUnreadablePrStateAttempt matches the cap-parked needs_attention shape", () => {
  // Same prefix on the cap-park row so the pattern is one signal, not two.
  assert.equal(isUnreadablePrStateAttempt(unreadableParked), true);
});

test("isUnreadablePrStateAttempt does NOT match a completed resolve", () => {
  assert.equal(isUnreadablePrStateAttempt(completedAttempt), false);
});

test("isUnreadablePrStateAttempt does NOT match an advisory-supersede park", () => {
  // Advisory-supersede is a real resolver verdict — the general cap owns it, not this one.
  assert.equal(isUnreadablePrStateAttempt(advisorySupersedeParked), false);
});

test("isUnreadablePrStateAttempt is defensive against null error / other statuses", () => {
  assert.equal(isUnreadablePrStateAttempt({ status: "failed", error: null }), false);
  assert.equal(isUnreadablePrStateAttempt({ status: "completed", error: `${PREFIX}: …` }), false);
  assert.equal(isUnreadablePrStateAttempt({ status: "queued", error: `${PREFIX}: …` }), false);
});

test("countPriorUnreadablePrStateAttempts counts BOTH retryable-failed and cap-parked rows", () => {
  // The runPrResolveJob decision: (priorUnreadable + this attempt) >= MAX ⇒ escalate. So the counter
  // must include EVERY prior unreadable shape (a bounce-off-the-cap-and-retry pattern cannot re-open
  // the loop).
  const rows = [unreadableFailedHttp5xx, unreadableFailed200MissingState];
  assert.equal(countPriorUnreadablePrStateAttempts(rows), 2);
  // With this attempt (the current run) the escalation predicate would trip at N = MAX.
  assert.equal(countPriorUnreadablePrStateAttempts([...rows, unreadableParked]), 3);
});

test("Two prior unreadable failures + this run = MAX → escalate (spec's cap predicate)", () => {
  const prior = [unreadableFailedHttp5xx, unreadableFailedHttp5xx];
  const wouldEscalate = countPriorUnreadablePrStateAttempts(prior) + 1 >= MAX;
  assert.equal(wouldEscalate, true, "3rd consecutive unreadable-state attempt escalates");
});

test("One prior unreadable failure + this run < MAX → stay retryable failed", () => {
  const prior = [unreadableFailedHttp5xx];
  const wouldEscalate = countPriorUnreadablePrStateAttempts(prior) + 1 >= MAX;
  assert.equal(wouldEscalate, false, "2nd unreadable attempt is still failed (retry)");
});

test("countPriorUnreadablePrStateAttempts is 0 when no prior unreadable rows exist", () => {
  // A brand-new PR sees zero prior unreadable rows → first unreadable read is failed (retryable).
  assert.equal(countPriorUnreadablePrStateAttempts([]), 0);
  assert.equal(countPriorUnreadablePrStateAttempts([completedAttempt, advisorySupersedeParked]), 0);
});

test("countGenuinePrResolveAttempts EXCLUDES unreadable-state rows (they never ran the resolver)", () => {
  // The general cap protects against pointless retries of a resolver that returned a verdict; an
  // unreadable-state row never even reached the resolver, so it must not burn that budget or a
  // transient GitHub blip would forever count against the 3-strike human-escalation budget.
  assert.equal(countGenuinePrResolveAttempts([unreadableFailedHttp5xx]), 0);
  assert.equal(countGenuinePrResolveAttempts([unreadableFailed200MissingState]), 0);
  assert.equal(countGenuinePrResolveAttempts([unreadableParked]), 0);
  assert.equal(
    countGenuinePrResolveAttempts([
      unreadableFailedHttp5xx,
      unreadableParked,
      unreadableFailed200MissingState,
    ]),
    0,
  );
});

test("countGenuinePrResolveAttempts still counts real verdicts alongside unreadable rows", () => {
  // Mixed pattern: two real resolver verdicts (one completed, one advisory-supersede) alongside
  // unreadable-state rows. The general cap counts only the two real ones.
  assert.equal(
    countGenuinePrResolveAttempts([
      unreadableFailedHttp5xx,
      completedAttempt,
      unreadableParked,
      advisorySupersedeParked,
    ]),
    2,
  );
});

test("THE NAMED FAILING STATE: a 200 with state=undefined must NOT be classified as terminal", () => {
  // Ground-truth signature of job 5720fb3a. The bug was that the old runPrResolveJob wrote a
  // 'completed / no longer open' row on this shape. Now: it's an unreadable-state row → the counter
  // recognizes it AND the general counter refuses to count it, so a retry is guaranteed. This test
  // is the regression pin: if a future refactor re-collapses the branches, this fails first.
  const row = { status: "failed", error: `${PREFIX}: could not read PR #2486 state (200 with state=undefined)` };
  assert.equal(isUnreadablePrStateAttempt(row), true, "state=undefined MUST classify as unreadable");
  // And the general cap must NOT count it — otherwise transient GitHub blips burn the 3-strike budget.
  assert.equal(countGenuinePrResolveAttempts([row]), 0, "unreadable never burns the general cap");
});
