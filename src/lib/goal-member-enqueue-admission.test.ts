/**
 * goal-serializer-one-decision-point Phase 1 — enqueue admission is PERMISSIVE.
 *
 * Pins the NAMED failing state from the 2026-07-16 dahlia deadlock: admission counted a `queued`
 * goal-mate as in-flight and REFUSED the earliest-ready head (while dispatch did NOT count queued
 * and HELD the queued mate behind the missing head — mutual deadlock, zero in-flight).
 *
 * Post-fix contract:
 *  - Any UNBLOCKED goal-mate always reaches `queued`. The only remaining refusal from admission is
 *    the global LANE CAP (`GOAL_MEMBER_MAX_PARALLEL_LANES`) counted from GENUINELY-executing
 *    goal-mates (statuses in `GOAL_INFLIGHT_STATUSES` — no queued/queued_resume).
 *  - Selection of the single buildable member among queued+ready candidates moves entirely to
 *    claim-time dispatch (`decideGoalMemberBuildDispatch`).
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

test("dahlia replay — an unblocked head admits even when a later goal-mate is queued", () => {
  // The 2026-07-16 dahlia deadlock shape: dahlia-deeper-competitor-selection was `queued` (a later
  // member) while the earliest-ready head had no job — admission had refused it because a queued
  // sibling existed. Post-fix: `queued` is NOT in-flight; admission passes.
  const members = [m("dahlia-head"), m("dahlia-deeper-competitor-selection", { blockedBy: ["dahlia-head"] })];
  const goalSlug = "dahlia-imitate-then-innovate-copy-engine";
  const inflight: GoalMemberInflightRow[] = [
    { slug: "dahlia-deeper-competitor-selection", status: "queued" },
  ];
  const r = decideGoalMemberEnqueueAdmission({ slug: "dahlia-head", goalSlug, inflight, members });
  assert.deepEqual(r, { ok: true }, "the queue is permissive — a queued sibling never blocks a head");
});

test("two unblocked goal-mates both reach `queued` when no genuine in-flight exists", () => {
  // Post-Phase-1: the queue is permissive. Both mates enqueue; dispatch will pick the earliest-
  // ready at claim time. Pre-fix (Phase-2 admission) refused a mate when its sibling was `queued`
  // — the bug this spec removes.
  const members = [m("a-spec"), m("b-spec"), m("c-spec")];
  const goalSlug = "some-goal";

  for (const slug of ["a-spec", "b-spec", "c-spec"]) {
    const r = decideGoalMemberEnqueueAdmission({ slug, goalSlug, inflight: [], members });
    assert.deepEqual(r, { ok: true }, `${slug} should admit — no in-flight, queue is permissive`);
  }
});

test("a queued sibling — even a transitive-blocker one — no longer blocks admission", () => {
  // c-spec blocked_by b-spec blocked_by a-spec. a-spec is `queued`. Pre-fix (Phase-2 admission)
  // refused c-spec on transitive-blocker-in-flight; post-fix `queued` is not in-flight so c-spec
  // admits. The dispatcher (claim-time) still enforces order: c-spec will not actually build until
  // a-spec + b-spec integrate onto the goal branch — but c-spec is allowed to sit in the queue.
  const members = [
    m("a-spec"),
    m("b-spec", { blockedBy: ["a-spec"] }),
    m("c-spec", { blockedBy: ["b-spec"] }),
  ];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "queued" }];

  const r = decideGoalMemberEnqueueAdmission({ slug: "c-spec", goalSlug, inflight, members });
  assert.deepEqual(r, { ok: true }, "queue is permissive — a queued sibling never refuses admission");
});

test("lane cap bounds concurrency using only GENUINELY-executing mates (no queued)", () => {
  // Post-Phase-1 the cap counts only mates in GOAL_INFLIGHT_STATUSES. A queued sibling never counts
  // — it's a candidate for the goal's serial slot, not a slot-holder.
  const laneCap = 3;
  const members = [m("a-spec"), m("b-spec"), m("c-spec"), m("d-spec"), m("z-spec")];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [
    { slug: "a-spec", status: "queued" },
    { slug: "b-spec", status: "building" },
    { slug: "c-spec", status: "claimed" },
  ];

  // Only b-spec + c-spec count (both executing). queued a-spec is stripped. 2 < cap=3 → admits.
  const r = decideGoalMemberEnqueueAdmission({ slug: "d-spec", goalSlug, inflight, members, laneCap });
  assert.deepEqual(r, { ok: true }, "queued sibling is not counted against the cap");
});

test("lane cap refuses when GENUINE executing mates saturate the cap", () => {
  // The residual refusal in admission: the box's build pool can be drained by one goal if
  // GOAL_MEMBER_MAX_PARALLEL_LANES concurrent goal-mates are already executing.
  const laneCap = 3;
  const members = [m("a-spec"), m("b-spec"), m("c-spec"), m("d-spec"), m("z-spec")];
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [
    { slug: "a-spec", status: "building" },
    { slug: "b-spec", status: "claimed" },
    { slug: "c-spec", status: "needs_input" },
  ];
  const r = decideGoalMemberEnqueueAdmission({ slug: "d-spec", goalSlug, inflight, members, laneCap });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /serialized-goal-mate-lane-cap/);
    assert.match(r.reason, new RegExp(`cap ${laneCap}`));
  }
});

test("lane cap default matches `GOAL_MEMBER_MAX_PARALLEL_LANES` (module-level constant)", () => {
  // Belt-and-suspenders: `building` fills every slot; the (N+1)th mate must refuse.
  const members = Array.from({ length: GOAL_MEMBER_MAX_PARALLEL_LANES + 1 }, (_, i) =>
    m(`spec-${String.fromCharCode(97 + i)}`),
  );
  const inflight: GoalMemberInflightRow[] = Array.from(
    { length: GOAL_MEMBER_MAX_PARALLEL_LANES },
    (_, i) => ({ slug: `spec-${String.fromCharCode(97 + i)}`, status: "building" }),
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

test("a self-row in the inflight list does not block the enqueue for the same slug", () => {
  const r = decideGoalMemberEnqueueAdmission({
    slug: "a-spec",
    goalSlug: "some-goal",
    inflight: [{ slug: "a-spec", status: "building" }],
    members: [m("a-spec")],
  });
  assert.deepEqual(r, { ok: true });
});

test("legacy caller (no `members` provided) — still permissive under the lane cap", () => {
  // A pre-Phase-1 caller that omits `members` still gets a lane-cap-only admission. Even with an
  // executing sibling, an independent mate admits (only cap saturation refuses).
  const goalSlug = "some-goal";
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "building" }];

  const rb = decideGoalMemberEnqueueAdmission({ slug: "b-spec", goalSlug, inflight });
  assert.deepEqual(rb, { ok: true }, "fallback admits — one executing mate is well under the cap");
});
