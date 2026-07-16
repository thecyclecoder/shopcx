/**
 * parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — serialized rebase-merge guard.
 *
 * Pins the NAMED failing state from the spec's Verification: two goal-mate branches touching the SAME
 * file, built in parallel (Phase 2's DAG-aware admission lets them run concurrently), merge one-at-a-time
 * with a REBASE and NO duplicate-symbol collision; an IRREDUCIBLE conflict ESCALATES rather than
 * force-merging.
 *
 * The pure predicate `decideGoalBranchRebaseMerge` is the seam this test exercises directly — it takes a
 * GitHub compare-API result + the number of prior rebase attempts and decides `merge` / `rebase-then-merge`
 * / `skip` / `escalate`. The async wrapper `mergeSpecBranchIntoGoalBranch` calls it, runs the rebase (merge
 * goal-branch INTO spec-branch) on `rebase-then-merge`, escalates on rebase-409 or attempt exhaustion, and
 * only then does the spec→goal merge. A per-goal in-process mutex serializes concurrent invocations for
 * the SAME goal (different goals proceed in parallel).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-branch-rebase-merge.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGoalBranchRebaseMerge,
  GOAL_BRANCH_REBASE_MAX_ATTEMPTS,
  _peekGoalBranchMergeSerializer,
  _withGoalBranchMergeLockForTests,
  type GoalBranchCompareResult,
} from "./github-pr-resolve";

function cmp(overrides: Partial<GoalBranchCompareResult> = {}): GoalBranchCompareResult {
  return {
    status: "identical",
    aheadBy: 0,
    behindBy: 0,
    headSha: "spec-tip",
    baseSha: "goal-tip",
    ...overrides,
  };
}

test("identical: spec branch head equals goal branch head → skip (nothing to merge)", () => {
  const d = decideGoalBranchRebaseMerge({ compare: cmp({ status: "identical" }) });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /identical/);
});

test("behind: spec branch is behind goal branch → skip (spec already integrated)", () => {
  const d = decideGoalBranchRebaseMerge({ compare: cmp({ status: "behind", behindBy: 3 }) });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /behind/);
});

test("ahead: spec branch has commits goal branch doesn't → direct merge is safe (no rebase needed)", () => {
  const d = decideGoalBranchRebaseMerge({ compare: cmp({ status: "ahead", aheadBy: 5 }) });
  assert.equal(d.action, "merge");
  assert.match(d.reason, /ahead by 5/);
  assert.match(d.reason, /fast-forwardable/);
});

test("diverged: goal branch has advanced beneath spec branch → rebase-then-merge (the Phase 3 unlock)", () => {
  // The named failing state — two parallel goal-mates touched one file, so the goal branch advanced
  // beneath this spec branch. WITHOUT the rebase step, the direct spec→goal merge could still succeed
  // (GitHub API would produce a spurious merge commit if the file overlap is at different lines) or
  // 409 (if the file overlap is at the same line). WITH the rebase step, we bring the goal branch's
  // sibling advances INTO the spec branch FIRST, then the spec→goal merge is a clean fast-forward
  // against the now-current base — no phantom merge commit, no #1893-style duplicate-symbol collision.
  const d = decideGoalBranchRebaseMerge({
    compare: cmp({ status: "diverged", aheadBy: 3, behindBy: 4 }),
    priorRebaseAttempts: 0,
  });
  assert.equal(d.action, "rebase-then-merge");
  assert.match(d.reason, /ahead=3/);
  assert.match(d.reason, /behind=4/);
});

test("diverged + prior rebase attempts EXHAUSTED → escalate (irreducible), never force-merge", () => {
  // The Verification's second assertion — after `GOAL_BRANCH_REBASE_MAX_ATTEMPTS` attempts the compare
  // still says `diverged`, the conflict is real. Escalate; the human/pr-resolve flow reconciles.
  // Post-fix: predicate MUST NOT return `merge` here (that would be a force-merge over unresolved
  // conflict); the escalate action is the only acceptable output.
  const d = decideGoalBranchRebaseMerge({
    compare: cmp({ status: "diverged", aheadBy: 1, behindBy: 1 }),
    priorRebaseAttempts: GOAL_BRANCH_REBASE_MAX_ATTEMPTS,
  });
  assert.equal(d.action, "escalate");
  assert.match(d.reason, /irreducible/);
  assert.notEqual(d.action, "merge", "never force-merge on exhausted attempts");
});

test("diverged + one prior attempt (< max) → keep trying, another rebase-then-merge", () => {
  const d = decideGoalBranchRebaseMerge({
    compare: cmp({ status: "diverged", aheadBy: 1, behindBy: 1 }),
    priorRebaseAttempts: 1,
    maxAttempts: 3,
  });
  assert.equal(d.action, "rebase-then-merge");
});

test("malformed compare payload (missing status) → escalate (fail closed, never accidentally merge)", () => {
  // Defense-in-depth: a compare payload with no `status` field must NOT default to `merge`. The
  // predicate returns `escalate` so the caller writes a director_activity + holds the promotion.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = decideGoalBranchRebaseMerge({ compare: { status: "" } as unknown as GoalBranchCompareResult });
  assert.equal(d.action, "escalate");
  assert.match(d.reason, /fail closed/);
});

test("GOAL_BRANCH_REBASE_MAX_ATTEMPTS is at least 2 (one retry catches races; second means real)", () => {
  // The constant itself is part of the contract — if it drops below 2, a benign race between compare
  // and merge would blow up as an escalation on every diverged case.
  assert.ok(GOAL_BRANCH_REBASE_MAX_ATTEMPTS >= 2);
});

test("per-goal serialization mutex: two concurrent bodies for the SAME goal-branch run strictly one-at-a-time", async () => {
  // The Verification's "one-at-a-time" clause. Post-fix: two body invocations sharing the same goal-
  // branch cannot interleave — the second's body starts strictly AFTER the first's body ends. Detected
  // via a shared "concurrent-callers" counter: a body increments on entry, decrements on exit, and
  // asserts the counter is always ≤1. Pre-fix (no mutex) the counter would hit 2 mid-run.
  const goalBranch = "goal/test-serial";
  let concurrent = 0;
  let maxConcurrent = 0;
  const body = async (label: string): Promise<string> => {
    concurrent += 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    // Yield across a few microtasks so a broken mutex would give the second caller a chance to enter.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    concurrent -= 1;
    return label;
  };
  const p1 = _withGoalBranchMergeLockForTests(goalBranch, () => body("first"));
  const p2 = _withGoalBranchMergeLockForTests(goalBranch, () => body("second"));
  // Mutex slot is occupied while calls are in-flight (either p1 running or p2 queued behind it).
  assert.notEqual(_peekGoalBranchMergeSerializer(goalBranch), undefined, "mutex slot is occupied while calls are in-flight");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, "first");
  assert.equal(r2, "second");
  assert.equal(maxConcurrent, 1, "same-goal-branch bodies must never run concurrently");
});

test("different goals serialize INDEPENDENTLY (mutex is per-goal, not global) — cross-goal parallelism preserved", async () => {
  // Two body invocations for DIFFERENT goal-branches proceed concurrently — the mutex is per-key.
  // A concurrent-caller counter scoped by goal-branch confirms each goal has its own slot.
  let bothInFlight = false;
  const a = _withGoalBranchMergeLockForTests("goal/test-indep-a", async () => {
    // Wait until B also enters, then resolve.
    const t0 = Date.now();
    while (!bBodyEntered && Date.now() - t0 < 500) {
      await new Promise((r) => setImmediate(r));
    }
    bothInFlight = bBodyEntered;
    return "a";
  });
  let bBodyEntered = false;
  const b = _withGoalBranchMergeLockForTests("goal/test-indep-b", async () => {
    bBodyEntered = true;
    // Wait a beat so A observes the overlap.
    await new Promise((r) => setImmediate(r));
    return "b";
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, "a");
  assert.equal(rb, "b");
  assert.equal(bothInFlight, true, "cross-goal-branch bodies must be able to run concurrently");
});

test("mutex chains across a body that THROWS — next queued body still runs (fault-isolation)", async () => {
  // If the first body throws, the mutex slot must still release so the second body can proceed.
  // Otherwise a single failure would wedge every subsequent goal-branch merge forever.
  const goalBranch = "goal/test-fault";
  const p1 = _withGoalBranchMergeLockForTests(goalBranch, async () => {
    throw new Error("boom");
  });
  const p2 = _withGoalBranchMergeLockForTests(goalBranch, async () => "recovered");
  await assert.rejects(p1, /boom/);
  const r2 = await p2;
  assert.equal(r2, "recovered", "second body still runs after the first throws");
});
