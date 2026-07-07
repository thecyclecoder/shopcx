/**
 * serialize-goal-member-spec-builds Phase 1 — dispatch-eligibility predicate.
 *
 * Pins the NAMED failing state from the 2026-07-06 jam: 8 kind='build' jobs for guaranteed-ticket-
 * handling member specs all cleared their individual blocked_by leg and dispatched concurrently,
 * colliding on action-executor.ts + refund handlers (#1245/#1246/#1248 parked DIRTY). The pure
 * predicate MUST let exactly one goal-member dispatch at a time — the next one only after the prior
 * lands on the goal branch. Cross-goal parallelism is unaffected (a one-off spec / a member of a
 * different goal simply never reaches this predicate — the caller no-ops).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/serialize-goal-member-build-dispatch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGoalMemberBuildDispatch,
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

test("2+ ready goal-mates, none in-flight: exactly one is claimable", () => {
  // The 2026-07-06 jam shape — 3 goal-mates all with cleared blockers, zero in-flight, none on the
  // goal branch. Pre-fix: all three passed the gate and dispatched. Post-fix: exactly one (the
  // alphabetically-first head) wins; the rest hold.
  const members = [m("a-spec"), m("b-spec"), m("c-spec")];
  const inflight: GoalMemberInflightRow[] = [];
  const goalSlug = "guaranteed-ticket-handling";

  const wins = ["a-spec", "b-spec", "c-spec"].map((slug) =>
    decideGoalMemberBuildDispatch({ slug, goalSlug, members, inflight }),
  );
  const ok = wins.filter((r) => r.ok).length;
  assert.equal(ok, 1, "exactly one goal-mate may dispatch at a time");
  assert.deepEqual(wins[0], { ok: true }, "a-spec (alphabetically first head) wins");
  assert.equal(wins[1].ok, false);
  assert.equal(wins[2].ok, false);
});

test("second becomes claimable only after the prior merges onto the goal branch", () => {
  const inflight: GoalMemberInflightRow[] = [];
  const goalSlug = "guaranteed-ticket-handling";

  // Round 1: a-spec wins.
  const round1 = [m("a-spec"), m("b-spec"), m("c-spec")];
  assert.deepEqual(decideGoalMemberBuildDispatch({ slug: "a-spec", goalSlug, members: round1, inflight }), { ok: true });
  assert.equal(decideGoalMemberBuildDispatch({ slug: "b-spec", goalSlug, members: round1, inflight }).ok, false);

  // a-spec builds + merges onto the goal branch (onGoalBranch=true). Now b-spec is the earliest head.
  const round2 = [m("a-spec", { onGoalBranch: true }), m("b-spec"), m("c-spec")];
  assert.deepEqual(decideGoalMemberBuildDispatch({ slug: "b-spec", goalSlug, members: round2, inflight }), { ok: true });
  // c-spec still held (b is next).
  assert.equal(decideGoalMemberBuildDispatch({ slug: "c-spec", goalSlug, members: round2, inflight }).ok, false);
});

test("any other goal-mate in-flight blocks dispatch (in-flight guard)", () => {
  const members = [m("a-spec"), m("b-spec")];
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "building" }];
  const goalSlug = "guaranteed-ticket-handling";

  // b-spec (which is NOT in-flight) must be held because a-spec is running.
  const r = decideGoalMemberBuildDispatch({ slug: "b-spec", goalSlug, members, inflight });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /in-flight for goal/);
});

test("goal-mate blocker ordering: a-spec blocks b-spec until on-goal-branch", () => {
  // b-spec explicitly blocked_by a-spec. a-spec is unbuilt, so b-spec is NOT a ready head; a-spec IS.
  const members = [m("a-spec"), m("b-spec", { blockedBy: ["a-spec"] })];
  const inflight: GoalMemberInflightRow[] = [];
  const goalSlug = "guaranteed-ticket-handling";

  assert.deepEqual(decideGoalMemberBuildDispatch({ slug: "a-spec", goalSlug, members, inflight }), { ok: true });
  const rb = decideGoalMemberBuildDispatch({ slug: "b-spec", goalSlug, members, inflight });
  assert.equal(rb.ok, false);

  // After a-spec lands, b-spec becomes the earliest head.
  const post = [m("a-spec", { onGoalBranch: true }), m("b-spec", { blockedBy: ["a-spec"] })];
  assert.deepEqual(decideGoalMemberBuildDispatch({ slug: "b-spec", goalSlug, members: post, inflight }), { ok: true });
});

test("all members already on the goal branch (degenerate): dispatch is allowed", () => {
  // Race-safety: the check MUST NOT falsely block a call for a spec whose goal has nothing left to
  // serialize (all members already on the branch — the caller is likely a resume/promote path).
  const members = [
    m("a-spec", { onGoalBranch: true }),
    m("b-spec", { onGoalBranch: true }),
  ];
  const inflight: GoalMemberInflightRow[] = [];
  assert.deepEqual(
    decideGoalMemberBuildDispatch({ slug: "a-spec", goalSlug: "g", members, inflight }),
    { ok: true },
  );
});

test("in-flight row for THIS spec itself does not block itself", () => {
  // The caller is dispatching THIS spec (freshly claimed → status='claimed'). The in-flight query is
  // meant to filter it out via .neq('spec_slug', slug); the pure predicate mirrors that with the
  // `r.slug !== slug` check — assert that a self-row in the input never falsely blocks.
  const members = [m("a-spec")];
  const inflight: GoalMemberInflightRow[] = [{ slug: "a-spec", status: "claimed" }];
  assert.deepEqual(
    decideGoalMemberBuildDispatch({ slug: "a-spec", goalSlug: "g", members, inflight }),
    { ok: true },
  );
});
