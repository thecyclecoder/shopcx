/**
 * Pins the Phase 1 invariants for docs/brain/specs/review-candidacy-detector-
 * lane-backpressure-and-completed-de.md:
 *
 * 1. **Bounded enqueue** — a detector tick returns at most
 *    `REVIEW_CANDIDACY_ENQUEUE_CAP` capped rows even when many more are
 *    eligible; the overflow reports as `deferred` so the CT stuck-lane
 *    threshold reflects real worker failure, not detector backpressure into
 *    the concurrency-1 Sol lane.
 * 2. **Completed-verdict cooldown** — a ticket whose id appears in the
 *    recent-verdict slug set (a `review-candidacy` `agent_jobs` row in status
 *    `completed`, `failed`, or `needs_attention` within the cooldown window)
 *    is SKIPPED and counted in `skipped_recent_verdict`. Phase 1 does not
 *    persist a `review_requests` ledger row on Sol's verdict, so the
 *    agent_jobs row IS the fingerprint the next tick must respect.
 *
 * The failing state these exist to prevent: the review-candidacy detector
 * was enqueueing up to 50 jobs per tick into a lane that runs one Sol
 * session at a time, AND re-enqueueing tickets that already produced a
 * completed verdict on a prior tick — so the same quiet ticket was
 * reconsidered every 30 min for the remainder of its 7-day eligibility.
 *
 * Run: npx tsx --test src/lib/inngest/review-candidacy-detector-cron.selection.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_CANDIDACY_ENQUEUE_CAP,
  REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS,
  selectReviewCandidacyBatch,
  type ReviewCandidacyBatchRow,
} from "./review-candidacy-detector-cron";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const OUTBOUND_25H_AGO = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
const CREATED_2D_AGO = new Date(
  NOW - 2 * 24 * 60 * 60 * 1000,
).toISOString();

function makeRow(i: number): ReviewCandidacyBatchRow {
  return {
    id: `ticket-${i}`,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    customer_id: `customer-${i}`,
    created_at: CREATED_2D_AGO,
  };
}

function makeLatestExternal(
  rows: ReviewCandidacyBatchRow[],
): Map<string, { at: string; direction: "inbound" | "outbound" | null }> {
  const map = new Map<
    string,
    { at: string; direction: "inbound" | "outbound" | null }
  >();
  for (const r of rows) {
    map.set(r.id, { at: OUTBOUND_25H_AGO, direction: "outbound" });
  }
  return map;
}

/**
 * Every pre-existing test in this file predates the two-sided gate and assumes
 * its rows ARE real conversations. This mirrors that assumption explicitly so
 * those tests keep testing what they were written to test.
 */
function allTwoSided(rows: ReviewCandidacyBatchRow[]): Set<string> {
  return new Set(rows.map((r) => r.id));
}

test("skip: a ticket with a recent COMPLETED review-candidacy verdict is not re-enqueued", () => {
  // The named failing state: the detector reconsidered the same quiet ticket
  // every 30 min because Phase 1 does not write a review_requests row for
  // Sol's verdict — the previous filter only looked at INFLIGHT statuses
  // (queued / claimed / building / needs_input) and never saw a completed
  // job. This test asserts the CORRECT state before the fix: a ticket with a
  // completed verdict on file is dropped and counted in
  // `skipped_recent_verdict`.
  const rows = [makeRow(1)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    recentlyAskedCustomers: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentVerdictSlugs: new Set(["ticket-1"]),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.capped.length, 0);
  assert.equal(result.skipped_recent_verdict, 1);
});

test("skip: FAILED and NEEDS_ATTENTION verdicts are treated as terminal fingerprints too", () => {
  // The spec's cooldown set is { completed, failed, needs_attention } — the
  // caller (the cron's SQL) supplies the union in `recentVerdictSlugs`. This
  // test just confirms the pure selector does not care WHICH terminal status
  // produced the fingerprint; the set membership is what gates the skip.
  const rows = [makeRow(1), makeRow(2)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    recentlyAskedCustomers: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentVerdictSlugs: new Set(["ticket-1", "ticket-2"]),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.skipped_recent_verdict, 2);
  assert.equal(result.eligible.length, 0);
});

test("pass: a ticket with no recent verdict on file is enqueued as normal", () => {
  // Symmetry check — the cooldown skip only fires when the id is in the set;
  // an empty verdict set leaves the eligibility decision to the quiet-window
  // predicate alone (mirrors the pre-fix behavior for first-time tickets).
  const rows = [makeRow(1)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    recentlyAskedCustomers: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentVerdictSlugs: new Set(),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.capped.length, 1);
  assert.equal(result.skipped_recent_verdict, 0);
});

test("cap: enqueue is bounded to REVIEW_CANDIDACY_ENQUEUE_CAP even when more are eligible", () => {
  // The named failing state: the detector was enqueueing up to 50 jobs per
  // tick into a lane that runs one Sol session at a time — the concurrency-1
  // lane would sit red until Sol had drained the backlog. This test asserts
  // the CORRECT state: a tick with N > CAP eligible rows returns CAP capped
  // and (N - CAP) deferred.
  const rows = Array.from({ length: REVIEW_CANDIDACY_ENQUEUE_CAP + 3 }, (_, i) =>
    makeRow(i + 1),
  );
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    recentlyAskedCustomers: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentVerdictSlugs: new Set(),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, REVIEW_CANDIDACY_ENQUEUE_CAP + 3);
  assert.equal(result.capped.length, REVIEW_CANDIDACY_ENQUEUE_CAP);
  assert.equal(result.deferred, 3);
});

test("cap: enqueue cap is smaller than the pre-fix BATCH_SIZE=50, matching the concurrency-1 lane", () => {
  // Structural pin — a future edit that widens the enqueue cap back to the
  // pre-fix 50 (or beyond) violates the spec's lane-backpressure invariant.
  // The cap must remain small enough that the Sol lane can drain (or nearly
  // drain) before the next 30-min tick adds more.
  assert.ok(
    REVIEW_CANDIDACY_ENQUEUE_CAP <= 10,
    `REVIEW_CANDIDACY_ENQUEUE_CAP=${REVIEW_CANDIDACY_ENQUEUE_CAP} must remain a small lane-safe number`,
  );
});

test("cap: verdict-cooldown window is at least MAX_AGE_DAYS wide so any still-eligible ticket is covered", () => {
  // Structural pin — the cooldown must cover the full 7-day ticket-eligibility
  // window, otherwise a ticket reviewed on day 1 could be reconsidered on day
  // 6 while still in the quiet-outbound bucket. 14 * 24 = 336h at time of
  // writing (2× MAX_AGE_DAYS = 7).
  assert.ok(
    REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS >= 7 * 24,
    `REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS=${REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS} must cover the full ticket-eligibility window`,
  );
});

test("skip: the cooldown check does NOT double-count a verdict-skipped ticket in `eligible`", () => {
  // Boundary: a ticket that would have passed the window but for the verdict
  // fingerprint must be reflected in `skipped_recent_verdict` ONLY — never
  // returned as `eligible`. This locks the counter's semantics so a future
  // edit can't accidentally leak the ticket through downstream.
  const rows = [makeRow(1), makeRow(2)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    recentlyAskedCustomers: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentVerdictSlugs: new Set(["ticket-1"]),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0].id, "ticket-2");
  assert.equal(result.skipped_recent_verdict, 1);
});

test("skip: inflight status still takes precedence over the verdict cooldown counter", () => {
  // Ordering check — an inflight ticket should be dropped by the inflight
  // filter (which comes first), never counted as a verdict-cooldown skip
  // even if its id happens to appear in both sets. The two counters measure
  // different failure modes; conflating them would hide inflight-stack issues
  // behind a healthy-looking cooldown number.
  const rows = [makeRow(1)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(["ticket-1"]),
    recentlyAskedCustomers: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentVerdictSlugs: new Set(["ticket-1"]),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.skipped_recent_verdict, 0);
});


test("skip: a one-sided ticket (outbound only — the dunning shape) never reaches Sol", () => {
  // The live defect this gate closes. An automated payment-recovery ticket has
  // one outbound notice and zero customer replies, so "we spoke last" passes
  // trivially and the ticket burned a full Sol session. Her own verdict on it:
  // "with AI turns=0 she hasn't even responded, so there is no finished
  // conversation". A ticket the customer never wrote in is not a conversation.
  const rows = [makeRow(1)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    twoSidedTicketIds: new Set(), // no inbound → not two-sided
    recentlyAskedCustomers: new Set(),
    recentVerdictSlugs: new Set(),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.capped.length, 0);
  assert.equal(result.skipped_one_sided, 1);
});

test("keep: a genuine two-sided conversation still qualifies", () => {
  // The gate must not swallow the actual cohort. Same row, same window, only
  // difference is that both sides spoke.
  const rows = [makeRow(1)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    twoSidedTicketIds: allTwoSided(rows),
    recentlyAskedCustomers: new Set(),
    recentVerdictSlugs: new Set(),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.skipped_one_sided, 0);
});

test("mixed batch: one-sided rows are dropped, two-sided rows survive", () => {
  const rows = [makeRow(1), makeRow(2), makeRow(3)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    twoSidedTicketIds: new Set(["ticket-2"]),
    recentlyAskedCustomers: new Set(),
    recentVerdictSlugs: new Set(),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.deepEqual(result.eligible.map((r) => r.id), ["ticket-2"]);
  assert.equal(result.skipped_one_sided, 2);
});

test("the one-sided gate runs BEFORE the verdict-cooldown counter", () => {
  // Ordering matters for the counters: a one-sided ticket that also has a
  // recent verdict should be attributed to skipped_one_sided, not double
  // counted, so the heartbeat's numbers stay readable.
  const rows = [makeRow(1)];
  const result = selectReviewCandidacyBatch({
    rows,
    latestExternal: makeLatestExternal(rows),
    inflightSlugs: new Set(),
    twoSidedTicketIds: new Set(),
    recentlyAskedCustomers: new Set(),
    recentVerdictSlugs: new Set(["ticket-1"]),
    now: NOW,
    enqueueCap: REVIEW_CANDIDACY_ENQUEUE_CAP,
  });
  assert.equal(result.skipped_one_sided, 1);
  assert.equal(result.skipped_recent_verdict, 0);
});
