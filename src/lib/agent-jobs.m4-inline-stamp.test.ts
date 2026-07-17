/**
 * spec-goal-branch-pm-flow M4 — the deterministic goal-branch merge must stamp its OWN phases' `build_sha`
 * INLINE at merge time, so the spec-drift standing-pass heal is never needed on the normal path.
 *
 * THE NAMED FAILING STATE (dahlia-five-frameworks-copy-skill, PR #1968): the M4 merge stamped only
 * `specs.goal_branch_sha` and left the phases built-but-unstamped (`build_sha` NULL), so they sat in
 * in_progress limbo until Ada's `healed_built_unstamped` heal stamped them a tick later. This test pins the
 * fix: `phasesToStampBuiltOnGoalMerge` — the pure seam the promote loop applies after a successful merge —
 * selects exactly the phases the inline `stampPhaseBuilt` call must stamp, so post-merge NOTHING is left for
 * the heal to do (it would find every phase already built and no-op).
 *
 * Semantics under test (mirrors the goal-branch heal `backstopStuckAccumulation`, NOT the on-main
 * `stampPhaseShipped` reconcilers):
 *   - stamp build_sha (built-on-branch), never merge_sha/shipped — asserted by the selection driving
 *     stampPhaseBuilt in the loop; here we pin the SELECTION, which is the branch-vs-main decision's input.
 *   - only phases that are neither terminal (shipped/rejected) NOR already carrying a build_sha (the same
 *     not-already-stamped guard the heal uses) → idempotent, no double/over-stamp.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agent-jobs.m4-inline-stamp.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { phasesToStampBuiltOnGoalMerge } from "./agent-jobs";

type PhaseShape = { position: number; status: string; build_sha: string | null };

test("M4 inline stamp: a freshly-merged spec (all phases built-but-unstamped) stamps EVERY phase → heal has nothing to do", () => {
  // The dahlia-five-frameworks-copy-skill shape: P1/P2/P3 built on the branch (in_progress) but no build_sha.
  const phases: PhaseShape[] = [
    { position: 1, status: "in_progress", build_sha: null },
    { position: 2, status: "in_progress", build_sha: null },
    { position: 3, status: "in_progress", build_sha: null },
  ];
  assert.deepEqual(phasesToStampBuiltOnGoalMerge(phases), [1, 2, 3]);
});

test("M4 inline stamp is idempotent: a re-run over already-build_sha'd phases stamps NOTHING (no double-stamp)", () => {
  const phases: PhaseShape[] = [
    { position: 1, status: "in_progress", build_sha: "abc123" },
    { position: 2, status: "in_progress", build_sha: "abc123" },
    { position: 3, status: "in_progress", build_sha: "abc123" },
  ];
  assert.deepEqual(phasesToStampBuiltOnGoalMerge(phases), []);
});

test("M4 inline stamp never over-stamps terminal phases (shipped/rejected are excluded)", () => {
  const phases: PhaseShape[] = [
    { position: 1, status: "shipped", build_sha: "deadbeef" }, // already on main — never re-stamp
    { position: 2, status: "rejected", build_sha: null }, // terminal — never stamp
    { position: 3, status: "in_progress", build_sha: null }, // the only stampable one
  ];
  assert.deepEqual(phasesToStampBuiltOnGoalMerge(phases), [3]);
});

test("M4 inline stamp: mixed set stamps only the not-terminal, not-yet-stamped phases (sorted)", () => {
  const phases: PhaseShape[] = [
    { position: 3, status: "in_progress", build_sha: null }, // stamp
    { position: 1, status: "in_progress", build_sha: "seen" }, // already built — skip
    { position: 4, status: "planned", build_sha: null }, // stamp (unbuilt-but-now-merged)
    { position: 2, status: "shipped", build_sha: "x" }, // terminal — skip
  ];
  assert.deepEqual(phasesToStampBuiltOnGoalMerge(phases), [3, 4]);
});

test("M4 inline stamp: empty phase set is a no-op", () => {
  assert.deepEqual(phasesToStampBuiltOnGoalMerge([]), []);
});
