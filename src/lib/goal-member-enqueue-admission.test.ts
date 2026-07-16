/**
 * parallel-build-serialized-merge-and-deadlock-autobreak Phase 2 — DAG-aware enqueue admission.
 *
 * Pins the NAMED failing state from the spec's Verification: two mutually-independent goal-mates
 * (no direct or transitive blocked_by relationship) MUST both admit concurrently — the whole
 * point of Phase 2. Before Phase 2 the predicate refused ANY sibling that already had an active
 * build, forcing dependency-independent specs single-file through one lane; post-Phase-2, only a
 * TRANSITIVE-BLOCKER-in-flight refuses, capped at the global parallel-lane budget
 * (`GOAL_MEMBER_MAX_PARALLEL_LANES`, matching the box's build pool).
 *
 * The pure predicate is the seam this test exercises directly — it takes the caller's slug, the
 * goal's member DAG (each with `blocked_by`), and the current in-flight set, and answers "may
 * this enqueue proceed?". The wrapper reader `evaluateGoalMemberEnqueueAdmission` does the DB
 * work above it (resolve goal → list members via `goalBranchState` → read each `blocked_by` via
 * `getSpecFromDb` → `.in` on agent_jobs status ∈ ACTIVE_STATUSES).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-member-enqueue-admission.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGoalMemberEnqueueAdmission,
  GOAL_MEMBER_MAX_PARALLEL_LANES,
  type GoalMemberDispatchState,
  type GoalMemberInflightRow,
} from "./agent-jobs";

function m(slug: string, opts: Partial<GoalMemberDispatchState> = {}): GoalMemberDispatchState {
  return {
    slug,
    onGoalBranch: false,
    status: "planned",
    blockedBy: [],
    ...opts,
  };
}

test("two mutually-independent goal-mates admit concurrently (the Phase 2 unlock)", () => {
  // The named failing state from Phase 2 Verification. Pre-fix: b-spec would be refused because
  // a-spec is `queued`; forced single-file through the goal. Post-fix: b-spec has no blocker
  // relationship to a-spec (mutually independent), so admission passes.
  const members = [m("a-spec"), m("b-spec"), m("c-spec")];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "queued" }];

  const rb = decideGoalMemberEnqueueAdmission({ slug: "b-spec", goalSlug, inflight, members });
  assert.deepEqual(rb, { ok: true }, "b-spec is independent of a-spec — must admit");
  const rc = decideGoalMemberEnqueueAdmission({ slug: "c-spec", goalSlug, inflight, members });
  assert.deepEqual(rc, { ok: true }, "c-spec is independent of a-spec — must admit");
});

test("a spec whose direct blocker is in-flight is HELD (blocker-in-flight guard)", () => {
  // The named failing state from Phase 2 Verification. b-spec blocked_by a-spec; a-spec is
  // building. b-spec MUST NOT admit until a-spec merges (the reactive re-fire re-runs
  // admission).
  const members = [m("a-spec"), m("b-spec", { blockedBy: ["a-spec"] })];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "building" }];

  const r = decideGoalMemberEnqueueAdmission({ slug: "b-spec", goalSlug, inflight, members });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /serialized-goal-mate-blocker-in-flight/);
    assert.match(r.reason, /a-spec/);
    assert.match(r.reason, /building/);
  }
});

test("a spec whose TRANSITIVE blocker is in-flight is HELD (defense-in-depth across the DAG chain)", () => {
  // c-spec blocked_by b-spec blocked_by a-spec. a-spec is `queued`. c-spec must be held because
  // its transitive blocker chain leads to an in-flight mate — even though its DIRECT blocker
  // (b-spec) isn't in-flight itself.
  const members = [
    m("a-spec"),
    m("b-spec", { blockedBy: ["a-spec"] }),
    m("c-spec", { blockedBy: ["b-spec"] }),
  ];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "queued" }];

  const r = decideGoalMemberEnqueueAdmission({ slug: "c-spec", goalSlug, inflight, members });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /serialized-goal-mate-blocker-in-flight/);
});

test("the lane cap bounds concurrency (goal-scoped global guard)", () => {
  // The named failing state from Phase 2 Verification. When the goal already saturates its
  // parallel-lane cap, admission MUST refuse a fresh mate even if it's mutually independent
  // — otherwise a fully-independent DAG would drain the whole build pool from one goal.
  const laneCap = 3;
  const members = [m("a-spec"), m("b-spec"), m("c-spec"), m("d-spec"), m("z-spec")];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [
    { slug: "a-spec", status: "queued" },
    { slug: "b-spec", status: "building" },
    { slug: "c-spec", status: "claimed" },
  ];

  const r = decideGoalMemberEnqueueAdmission({ slug: "d-spec", goalSlug, inflight, members, laneCap });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /serialized-goal-mate-lane-cap/);
    assert.match(r.reason, new RegExp(`cap ${laneCap}`));
  }
});

test("lane cap default matches `GOAL_MEMBER_MAX_PARALLEL_LANES` (module-level constant)", () => {
  // Belt-and-suspenders: if the cap is nudged in the module, the tests should catch a mismatch
  // between the exported constant and the predicate's default.
  const members = Array.from({ length: GOAL_MEMBER_MAX_PARALLEL_LANES + 1 }, (_, i) =>
    m(`spec-${String.fromCharCode(97 + i)}`),
  );
  const inflight: GoalMemberInflightRow[] = Array.from(
    { length: GOAL_MEMBER_MAX_PARALLEL_LANES },
    (_, i) => ({ slug: `spec-${String.fromCharCode(97 + i)}`, status: "queued" }),
  );
  const overflowSlug = `spec-${String.fromCharCode(97 + GOAL_MEMBER_MAX_PARALLEL_LANES)}`;

  const r = decideGoalMemberEnqueueAdmission({
    slug: overflowSlug,
    goalSlug: "some-goal",
    inflight,
    members,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /serialized-goal-mate-lane-cap/);
});

test("no goal-mate in-flight: admitted (baseline)", () => {
  const r = decideGoalMemberEnqueueAdmission({
    slug: "a-spec",
    goalSlug: "some-goal",
    inflight: [],
    members: [m("a-spec")],
  });
  assert.deepEqual(r, { ok: true });
});

test("a self-row in the inflight list does not block the enqueue for the same slug (defense-in-depth)", () => {
  // Mirror of the reader's self-row filter (which pre-Phase-2 was `.neq('spec_slug', slug)` at
  // the SQL layer; Phase 2 moved it into the predicate). Even if a stale read fed the same row
  // in, admission MUST NOT false-positive-refuse.
  const r = decideGoalMemberEnqueueAdmission({
    slug: "a-spec",
    goalSlug: "some-goal",
    inflight: [{ slug: "a-spec", status: "queued" }],
    members: [m("a-spec")],
  });
  assert.deepEqual(r, { ok: true });
});

test("legacy caller (no `members` provided) — falls back to lane-cap-only admission", () => {
  // A pre-Phase-2 caller that doesn't populate `members` falls back to the lane-cap gate only
  // (safer default: an over-admission is caught by the claim-time serializer + deadlock-
  // autobreak; an under-admission is exactly the Phase 1 stall we're fixing). Two independent
  // mates admit; only lane-cap saturation refuses.
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "queued" }];

  const rb = decideGoalMemberEnqueueAdmission({ slug: "b-spec", goalSlug, inflight });
  assert.deepEqual(rb, { ok: true }, "fallback admits mutually-independent-by-default");
});

test("shared-blocker independence: two mates that share an in-flight blocker are still held", () => {
  // Both b-spec and c-spec blocked_by a-spec; a-spec is `building`. Both are TRANSITIVELY
  // blocked by a-spec — neither admits until a-spec merges. This is the intended Phase 2
  // behavior (blocker-in-flight fires per-caller, not just for the first).
  const members = [
    m("a-spec"),
    m("b-spec", { blockedBy: ["a-spec"] }),
    m("c-spec", { blockedBy: ["a-spec"] }),
  ];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "building" }];

  for (const slug of ["b-spec", "c-spec"]) {
    const r = decideGoalMemberEnqueueAdmission({ slug, goalSlug, inflight, members });
    assert.equal(r.ok, false, `${slug} shares blocker a-spec — must be held`);
    if (!r.ok) assert.match(r.reason, /serialized-goal-mate-blocker-in-flight/);
  }
});

test("external / cross-goal blocker is ignored by the goal serializer (upstream gate's concern)", () => {
  // b-spec blocked_by 'external-spec' which is NOT in the goal's member set. The blocker-in-
  // flight walk should IGNORE it (external blockers are the async wrapper's / enqueueBuildIfDue's
  // blocked_by gate's concern). Admission passes.
  const members = [
    m("a-spec"),
    m("b-spec", { blockedBy: ["external-spec"] }),
  ];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "external-spec", status: "building" }];

  const r = decideGoalMemberEnqueueAdmission({ slug: "b-spec", goalSlug, inflight, members });
  assert.deepEqual(r, { ok: true });
});
