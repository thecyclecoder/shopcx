/**
 * goal-member-builds-gate-at-enqueue-not-at-claim Phase 2 — release-on-completion predicate.
 *
 * Pins the NAMED failing state from the spec's Verification: after the admitted goal-mate
 * merges, the release logic MUST pick the next eligible member (skipping shipped/folded specs +
 * specs already on the goal branch + the just-completed spec itself) in a DETERMINISTIC order
 * (alphabetical, so a re-run picks the same next slug and the chain converges).
 *
 * The pure predicate exercised here just answers "given the goal's current member roster + the
 * spec that just completed, which slugs are candidates to admit next, in what order?". The
 * async wrapper `admitNextGoalMemberOnCompletion` then walks that list calling
 * `enqueueBuildIfDue` — the FIRST admission that lands wins the goal's serial slot; any later
 * candidate is refused by Phase 1's `evaluateGoalMemberEnqueueAdmission` gate. The chain path
 * (queueNextChainedPhase) still fires first for a chain_phases=true spec; the release then
 * observes the freshly-queued next phase and no-ops.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-member-release-on-completion.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickNextGoalMemberCandidates, type GoalMemberReleaseCandidate } from "./agent-jobs";

function m(slug: string, opts: Partial<GoalMemberReleaseCandidate> = {}): GoalMemberReleaseCandidate {
  return { slug, status: "planned", onGoalBranch: false, ...opts };
}

test("skips the just-completed spec + returns remaining eligible members sorted alphabetically", () => {
  const members = [m("c-spec"), m("a-spec"), m("b-spec")];
  const picks = pickNextGoalMemberCandidates({ completedSlug: "a-spec", members });
  assert.deepEqual(picks, ["b-spec", "c-spec"], "alphabetical order — deterministic across re-runs");
});

test("shipped / folded members are skipped (already done)", () => {
  const members = [
    m("a-spec", { status: "shipped" }),
    m("b-spec", { status: "folded" }),
    m("c-spec"),
  ];
  const picks = pickNextGoalMemberCandidates({ completedSlug: "z-outside", members });
  assert.deepEqual(picks, ["c-spec"]);
});

test("members already on the goal branch are skipped (Gate B done, no fresh build to admit)", () => {
  const members = [
    m("a-spec", { onGoalBranch: true }),
    m("b-spec"),
    m("c-spec", { onGoalBranch: true }),
  ];
  const picks = pickNextGoalMemberCandidates({ completedSlug: "z-outside", members });
  assert.deepEqual(picks, ["b-spec"]);
});

test("goal with no eligible next member: empty list (release no-ops, cross-goal parallelism unaffected)", () => {
  const members = [m("a-spec", { onGoalBranch: true }), m("b-spec", { status: "shipped" })];
  const picks = pickNextGoalMemberCandidates({ completedSlug: "a-spec", members });
  assert.deepEqual(picks, []);
});

test("2+ ready members → exactly one alphabetically-first slug leads (matches Phase 1's Kahn tiebreak)", () => {
  // The chained flow: after a-spec merges, the release picks b-spec (the alphabetically-first
  // ready head). enqueueBuildIfDue admits b-spec; c-spec's admission would then be refused by
  // Phase 1's evaluateGoalMemberEnqueueAdmission (b-spec is now `queued`). Deterministic order
  // is what makes this convergent across re-runs (a re-run picks the same b-spec, sees it
  // already `queued`, no-ops on enqueueBuildIfDue's per-spec in-flight guard).
  const members = [m("a-spec", { onGoalBranch: true }), m("c-spec"), m("b-spec")];
  const picks = pickNextGoalMemberCandidates({ completedSlug: "a-spec", members });
  assert.deepEqual(picks, ["b-spec", "c-spec"]);
  assert.equal(picks[0], "b-spec", "b-spec is the earliest ready head");
});

test("null-status member (never-touched row) is still eligible — status enum only excludes shipped/folded", () => {
  // Defense-in-depth: goalBranchState reports `status: SpecStatus | null` for a spec row that
  // hasn't stamped a status yet (never claimed / never review'd). Such a row is a legitimate
  // future candidate — the enqueueBuildIfDue call below will gate on Vale + blocked_by anyway,
  // so we must NOT pre-drop it here.
  const members = [m("a-spec", { status: null }), m("b-spec")];
  const picks = pickNextGoalMemberCandidates({ completedSlug: "z-outside", members });
  assert.deepEqual(picks, ["a-spec", "b-spec"]);
});
