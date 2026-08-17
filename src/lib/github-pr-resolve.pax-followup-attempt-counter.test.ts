/**
 * pax-never-reports-nothing-to-resolve-on-a-pr-state-it-could-not-read (Phase 2) — unit tests for
 * the pure decision helpers behind `enqueuePaxFollowUp`'s end-of-pass self-requeue cap. Verifies:
 *   • the resolver's follow-up jobs carry an attempt counter on their instructions,
 *   • the counter increments monotonically across successive follow-ups for the same PR,
 *   • the cap trips at MAX_FOLLOWUP+1 (which the caller uses to insert a real_blocker sentinel),
 *   • the follow-up sentinel is EXCLUDED from the general pr-resolve retry-attempts counter.
 *
 *   npm run test:pr-resolve-pax-followup-attempt-counter
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  attemptCountOfPrResolveRow,
  highestPriorPaxFollowUpAttempt,
  isPaxFollowUpExhaustedSentinel,
  countGenuinePrResolveAttempts,
  PR_RESOLVE_FOLLOWUP_EXHAUSTED_PREFIX as EXHAUST_PREFIX,
  PR_RESOLVE_MAX_FOLLOWUP_ATTEMPTS_FOR_TESTS as MAX_FOLLOWUP,
} from "./github-pr-resolve";

/** The webhook-fired initial job (no `attempt` field on instructions) — counts as attempt 0. */
const initialWebhookJob = {
  status: "completed",
  error: null,
  instructions: JSON.stringify({ pr_number: 2486, branch: "claude/build-x", resolve_fingerprint: "aaaa:bbbb" }),
};
/** A first pax follow-up (attempt=1) — the artifact the spec's Verification bullet requires. */
const followUpAttempt1 = {
  status: "completed",
  error: null,
  instructions: JSON.stringify({
    pr_number: 2486,
    branch: "claude/build-x",
    reason: "pax follow-up",
    resolve_fingerprint: "aaaa:bbbb",
    attempt: 1,
  }),
};
/** A second pax follow-up (attempt=2). */
const followUpAttempt2 = { ...followUpAttempt1, instructions: JSON.stringify({ ...JSON.parse(followUpAttempt1.instructions), attempt: 2 }) };
/** A third pax follow-up (attempt=3) — the last allowed under MAX_FOLLOWUP=3. */
const followUpAttempt3 = { ...followUpAttempt1, instructions: JSON.stringify({ ...JSON.parse(followUpAttempt1.instructions), attempt: 3 }) };
/** The cap-park sentinel row `surfacePaxFollowUpExhausted` inserts on the MAX_FOLLOWUP+1th call. */
const exhaustedSentinel = {
  status: "needs_attention",
  error: `${EXHAUST_PREFIX}: PR #2486 needs a human merge after ${MAX_FOLLOWUP} pax follow-up attempts`,
  instructions: JSON.stringify({ pr_number: 2486 }),
};

test("MAX_FOLLOWUP is 3 (guard against constant drift)", () => {
  assert.equal(MAX_FOLLOWUP, 3);
});

test("attemptCountOfPrResolveRow reads `attempt` from instructions (the counter Verification requires)", () => {
  assert.equal(attemptCountOfPrResolveRow(initialWebhookJob), 0, "no attempt field → 0");
  assert.equal(attemptCountOfPrResolveRow(followUpAttempt1), 1);
  assert.equal(attemptCountOfPrResolveRow(followUpAttempt2), 2);
  assert.equal(attemptCountOfPrResolveRow(followUpAttempt3), 3);
});

test("attemptCountOfPrResolveRow is defensive against legacy / unparseable / negative values", () => {
  assert.equal(attemptCountOfPrResolveRow({ instructions: null }), 0);
  assert.equal(attemptCountOfPrResolveRow({ instructions: "not json" }), 0);
  assert.equal(attemptCountOfPrResolveRow({ instructions: JSON.stringify({ attempt: -1 }) }), 0);
  assert.equal(attemptCountOfPrResolveRow({ instructions: JSON.stringify({ attempt: "not a number" }) }), 0);
  assert.equal(attemptCountOfPrResolveRow({ instructions: JSON.stringify({}) }), 0);
});

test("highestPriorPaxFollowUpAttempt returns MAX across rows (0 when no attempts recorded)", () => {
  // The initial webhook job carries no `attempt` field so highest is 0 — the next follow-up
  // enqueues as attempt 1.
  assert.equal(highestPriorPaxFollowUpAttempt([initialWebhookJob]), 0);
  assert.equal(highestPriorPaxFollowUpAttempt([initialWebhookJob, followUpAttempt1]), 1);
  assert.equal(highestPriorPaxFollowUpAttempt([initialWebhookJob, followUpAttempt1, followUpAttempt2]), 2);
  // Out-of-order rows still work: MAX, not "last".
  assert.equal(highestPriorPaxFollowUpAttempt([followUpAttempt3, followUpAttempt1, followUpAttempt2]), 3);
});

test("The cap predicate: next=highest+1 > MAX_FOLLOWUP means enqueue REFUSES + surfaces real_blocker", () => {
  // After MAX successful follow-ups exist, the next enqueue's `nextAttempt` (=MAX+1) trips the cap.
  const prior = [initialWebhookJob, followUpAttempt1, followUpAttempt2, followUpAttempt3];
  const nextAttempt = highestPriorPaxFollowUpAttempt(prior) + 1;
  assert.equal(nextAttempt, MAX_FOLLOWUP + 1);
  assert.equal(nextAttempt > MAX_FOLLOWUP, true, "cap predicate trips at MAX+1");
  // At MAX-1 successful follow-ups, the next enqueue is fine (attempt=MAX).
  const priorBelow = [initialWebhookJob, followUpAttempt1, followUpAttempt2];
  const nextBelow = highestPriorPaxFollowUpAttempt(priorBelow) + 1;
  assert.equal(nextBelow, MAX_FOLLOWUP);
  assert.equal(nextBelow > MAX_FOLLOWUP, false, "at MAX-1 prior attempts, the MAXth is still enqueued");
});

test("isPaxFollowUpExhaustedSentinel identifies the cap-park marker", () => {
  assert.equal(isPaxFollowUpExhaustedSentinel(exhaustedSentinel), true);
  // Same status + wrong prefix → NOT a sentinel (e.g. the general exhausted-cap sentinel).
  assert.equal(
    isPaxFollowUpExhaustedSentinel({
      status: "needs_attention",
      error: "pr-resolve retry cap reached (3 attempts) — needs a human",
    }),
    false,
  );
  // Right prefix on a non-parked row → NOT a sentinel (defensive against a future refactor).
  assert.equal(
    isPaxFollowUpExhaustedSentinel({ status: "failed", error: `${EXHAUST_PREFIX}: something` }),
    false,
  );
  assert.equal(isPaxFollowUpExhaustedSentinel({ status: "needs_attention", error: null }), false);
});

test("countGenuinePrResolveAttempts EXCLUDES the follow-up exhausted sentinel (a marker, not a verdict)", () => {
  // The sentinel row must never count toward the general retry cap — otherwise the pax follow-up
  // system would burn the pr-resolve retry budget just by surfacing the cap park.
  assert.equal(countGenuinePrResolveAttempts([exhaustedSentinel]), 0);
  // Mixed set — one real resolver verdict + the sentinel should count as 1, not 2.
  assert.equal(
    countGenuinePrResolveAttempts([
      { status: "completed", error: null },
      exhaustedSentinel,
    ]),
    1,
  );
});

test("A follow-up job with attempt=N DOES count as a genuine resolve attempt (it ran the resolver)", () => {
  // A successful follow-up run is still a resolver verdict — it should count against the general
  // retry cap the same way a completed initial run does. The `attempt` field on instructions is
  // orthogonal — it drives the follow-up cap, not the general cap.
  assert.equal(countGenuinePrResolveAttempts([followUpAttempt1]), 1);
  assert.equal(countGenuinePrResolveAttempts([followUpAttempt1, followUpAttempt2, followUpAttempt3]), 3);
});

test("Round-trip: an instructions payload with attempt=N reads back as N", () => {
  // Regression pin: the exact instructions shape enqueuePaxFollowUp writes must round-trip through
  // the counter helper. If a future refactor renames `attempt` → `retryCount`, this fails first.
  const payload = JSON.stringify({
    pr_number: 2486,
    branch: "claude/build-x",
    reason: "pax follow-up: prior pass ended with PR still open + conflicting",
    resolve_fingerprint: "aaaa:bbbb",
    attempt: 2,
  });
  assert.equal(attemptCountOfPrResolveRow({ instructions: payload }), 2);
});
