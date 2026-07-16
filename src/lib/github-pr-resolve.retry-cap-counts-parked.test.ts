/**
 * pr-resolve-retry-cap-counts-parked-attempts (Phase 1) — unit test for the pure decision helper
 * `countGenuinePrResolveAttempts` behind [[enqueuePrResolveJob]]'s retry cap. The 2026-07 firehose
 * (#1893: 61 pr-resolve jobs / 7h on one PR) was caused by the counter excluding EVERY
 * `needs_attention` row — advisory-supersede parks (from builder-worker.ts) never counted toward the
 * cap, so the standing-pass dirty-PR backstop re-enqueued every pass and the cap was structurally
 * unreachable. Fix: include the advisory-supersede parks; exclude only the surfaced-cap sentinel.
 *
 *   npm run test:pr-resolve-retry-cap-counts-parked
 *   (= tsx --test src/lib/github-pr-resolve.retry-cap-counts-parked.test.ts)
 *
 * Verifies the spec's Phase 1 Verification bullet: given N needs_attention pr-resolve rows for one
 * PR, enqueuePrResolveJob refuses the N+1th enqueue (cap reached); below N it still enqueues. This
 * test covers the pure `countGenuinePrResolveAttempts` half — the caller (enqueuePrResolveJob) uses
 * `count >= MAX_ATTEMPTS` to gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  countGenuinePrResolveAttempts,
  PR_RESOLVE_MAX_ATTEMPTS_FOR_TESTS as MAX,
} from "./github-pr-resolve";

/** advisory-supersede park (builder-worker.ts:18120-18126) — the row this fix now counts. */
const advisorySupersedeParked = {
  status: "needs_attention",
  error: "advisory-supersede: 3 exported symbol(s) also appear on main",
};

/** The surfaced-cap sentinel from surfaceExhaustedPrResolve — a marker, never counted. */
const capSentinel = {
  status: "needs_attention",
  error: "pr-resolve retry cap reached (3 attempts) — needs a human",
};

/** An infra failure (worktree add / git push) — a box bug, never counted. */
const infraFailure = {
  status: "failed",
  error: "worktree add failed: fatal: 'wt' already used by worktree at …",
};

/** A completed resolver run (merged the PR clean) — always counts. */
const completedAttempt = { status: "completed", error: null };

/** A resolver run that failed on tsc after 2 attempts — the resolver ran to a verdict, so it counts. */
const failedResolveVerdict = { status: "failed", error: "resolver escalated: superseded" };

test("MAX is 3 (guard against the constant drifting away from this test's assertions)", () => {
  assert.equal(MAX, 3);
});

test("N advisory-supersede parks count toward the cap (the #1893 root fix)", () => {
  // BEFORE the fix these all returned 0; the cap never tripped and the storm ran for 7h.
  assert.equal(countGenuinePrResolveAttempts([advisorySupersedeParked]), 1);
  assert.equal(
    countGenuinePrResolveAttempts([advisorySupersedeParked, advisorySupersedeParked]),
    2,
  );
  assert.equal(
    countGenuinePrResolveAttempts([
      advisorySupersedeParked,
      advisorySupersedeParked,
      advisorySupersedeParked,
    ]),
    3,
  );
});

test("N parked attempts trip the cap; the N+1th enqueue would be refused (Verification bullet)", () => {
  const rows = Array.from({ length: MAX }, () => advisorySupersedeParked);
  // The pure counter's contract: below N genuine attempts, enqueuePrResolveJob still enqueues;
  // at or above N, it refuses. Same predicate the caller applies.
  assert.equal(countGenuinePrResolveAttempts(rows) >= MAX, true, "MAX parked → cap trips");
  assert.equal(
    countGenuinePrResolveAttempts(rows.slice(0, MAX - 1)) >= MAX,
    false,
    "MAX-1 parked → still enqueues",
  );
});

test("The surfaced-cap sentinel row does NOT count (a marker, not an attempt)", () => {
  // After the cap trips, surfaceExhaustedPrResolve inserts a sentinel row. On the NEXT enqueue
  // call, that sentinel row is present in the query result — but it must NOT count as an attempt,
  // or the accounting becomes double-count nonsense (already-parked N + a sentinel becomes N+1).
  assert.equal(countGenuinePrResolveAttempts([capSentinel]), 0);
  assert.equal(
    countGenuinePrResolveAttempts([
      advisorySupersedeParked,
      advisorySupersedeParked,
      advisorySupersedeParked,
      capSentinel,
    ]),
    3, // exactly MAX — not MAX+1 — because the sentinel is excluded
  );
});

test("Infra failures still excluded (pr-resolve-cap-ignores-infra-failures — worktree add / git push)", () => {
  assert.equal(countGenuinePrResolveAttempts([infraFailure]), 0);
  assert.equal(
    countGenuinePrResolveAttempts([
      { status: "failed", error: "git push failed" },
      { status: "failed", error: "ENOSPC: no space left on device" },
      { status: "failed", error: "could not lock config file" },
    ]),
    0,
  );
});

test("Completed + failed-with-resolve-verdict rows count (they ran the resolver to a decision)", () => {
  assert.equal(countGenuinePrResolveAttempts([completedAttempt]), 1);
  assert.equal(countGenuinePrResolveAttempts([failedResolveVerdict]), 1);
  assert.equal(
    countGenuinePrResolveAttempts([completedAttempt, failedResolveVerdict]),
    2,
  );
});

test("Mixed real-world set: 2 advisory parks + 1 infra failure + 1 sentinel counts as 2 (not 4)", () => {
  // The exact shape that produced #1893: parked attempts weren't counted, infra failures weren't
  // counted, so the cap never tripped. With the fix, parked attempts count (2) but the sentinel and
  // infra failure don't → 2 < MAX=3 → still enqueue. One more parked run trips the cap.
  const rows = [advisorySupersedeParked, advisorySupersedeParked, infraFailure, capSentinel];
  assert.equal(countGenuinePrResolveAttempts(rows), 2);
  assert.equal(countGenuinePrResolveAttempts([...rows, advisorySupersedeParked]), 3);
});

test("A needs_attention row with a NON-sentinel error still counts (defensive against new park kinds)", () => {
  // If a future code path parks pr-resolve to needs_attention with a different error, that also
  // represents a resolver verdict and should count. Only the surfaced-cap sentinel is a "marker".
  assert.equal(
    countGenuinePrResolveAttempts([{ status: "needs_attention", error: "some other park reason" }]),
    1,
  );
});

test("Null error on needs_attention does not accidentally match the sentinel prefix", () => {
  // The sentinel check uses `(error ?? "").startsWith(...)`, so a null error becomes "" which does
  // NOT start with "pr-resolve retry cap reached" → the row counts. Defensive.
  assert.equal(
    countGenuinePrResolveAttempts([{ status: "needs_attention", error: null }]),
    1,
  );
});
