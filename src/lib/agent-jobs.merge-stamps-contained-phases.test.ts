/**
 * Unit tests for `selectPhasesShippedByMerge`
 * ([[../specs/a-merge-stamps-only-the-phases-whose-code-it-actually-contains]] Phase 1).
 *
 * Pins the NAMED FAILING STATE from the spec:
 *   `phase-accumulation-verifies-the-pushed-branch-not-the-boxs-local-copy` folded 2026-08-17 with
 *   P1 `build=a0e1172ce merge=9ea6351de` and P2 `build=(none) merge=9ea6351de`. The old blanket-stamp
 *   flipped P2 shipped against a merge that never carried its code, folded the spec, and left the real
 *   P2 code stranded on unmerged PR #2508.
 *
 * The pure predicate under test decides which phase positions a merge stamps shipped:
 *   - never a terminal phase (shipped/rejected);
 *   - never a phase whose `build_sha` is null (rule 2 — no build evidence, no stamp);
 *   - otherwise iff the containment predicate returns true for that build_sha.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agent-jobs.merge-stamps-contained-phases.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectPhasesShippedByMerge, type PhaseForStampSelection } from "./agent-jobs";

test("the named failing state: P1 has a build_sha in the merge, P2's build_sha is NULL → stamp only P1", () => {
  const phases: PhaseForStampSelection[] = [
    { position: 1, status: "in_progress", build_sha: "a0e1172ce" },
    { position: 2, status: "in_progress", build_sha: null }, // the exact shape that stranded #2508
  ];
  // Containment says: yes, this merge (9ea6351de) contains a0e1172ce.
  const contains = (sha: string) => sha === "a0e1172ce";
  assert.deepEqual(selectPhasesShippedByMerge(phases, contains), [1]);
});

test("a phase whose build_sha is NOT an ancestor of the merge is left unstamped", () => {
  const phases: PhaseForStampSelection[] = [
    { position: 1, status: "in_progress", build_sha: "aaaaaaa" }, // this merge contains it
    { position: 2, status: "in_progress", build_sha: "bbbbbbb" }, // this merge does NOT
    { position: 3, status: "in_progress", build_sha: "ccccccc" }, // this merge does NOT
  ];
  const contains = (sha: string) => sha === "aaaaaaa";
  assert.deepEqual(selectPhasesShippedByMerge(phases, contains), [1]);
});

test("terminal phases (shipped/rejected) are never re-stamped, even if their build_sha is contained", () => {
  const phases: PhaseForStampSelection[] = [
    { position: 1, status: "shipped", build_sha: "aaaaaaa" }, // already on main
    { position: 2, status: "rejected", build_sha: "bbbbbbb" }, // terminal
    { position: 3, status: "in_progress", build_sha: "ccccccc" }, // the only stampable one
  ];
  assert.deepEqual(selectPhasesShippedByMerge(phases, () => true), [3]);
});

test("a phase with NULL build_sha is NEVER stamped — even if some notion of containment would say true", () => {
  const phases: PhaseForStampSelection[] = [
    { position: 1, status: "in_progress", build_sha: null },
    { position: 2, status: "planned", build_sha: null },
  ];
  // Even a permissive contains(): a null build_sha has no evidence to check against.
  assert.deepEqual(selectPhasesShippedByMerge(phases, () => true), []);
});

test("a fully-accumulated spec whose every phase's build IS contained → stamp every non-terminal phase", () => {
  const phases: PhaseForStampSelection[] = [
    { position: 1, status: "in_progress", build_sha: "aaaaaaa" },
    { position: 2, status: "in_progress", build_sha: "bbbbbbb" },
    { position: 3, status: "in_progress", build_sha: "ccccccc" },
  ];
  assert.deepEqual(selectPhasesShippedByMerge(phases, () => true), [1, 2, 3]);
});

test("results come back position-sorted (mixed-order input still yields ascending output)", () => {
  const phases: PhaseForStampSelection[] = [
    { position: 3, status: "in_progress", build_sha: "cccc" },
    { position: 1, status: "in_progress", build_sha: "aaaa" },
    { position: 2, status: "in_progress", build_sha: "bbbb" },
  ];
  assert.deepEqual(selectPhasesShippedByMerge(phases, () => true), [1, 2, 3]);
});

test("empty phase list is a no-op", () => {
  assert.deepEqual(selectPhasesShippedByMerge([], () => true), []);
});
