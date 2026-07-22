/**
 * merge-gate-verifies-real-phase-checks P2 — unit tests for the reconciler's blanket-stamp guard.
 *
 * Pins the correct state per the Phase-2 verification bullet:
 *   "reconciler uses the branch-check verifier before stamping"
 *
 * `reconcileMergedSpecPhases` (src/lib/agent-jobs.ts) USED to blanket-stamp every un-shipped phase with
 * a sibling's merge_sha with ZERO code check — the exact wedge the spec cites (v3 factor-rollup-sdk-
 * with-significance-gate phantom-shipped P2/P3). The pure `partitionPhasesByVerifyVerdict` helper is
 * the seam the reconciler now uses: given per-phase verify verdicts, it returns exactly the phases the
 * reconciler will stamp — everything else is REFUSED (left un-shipped for the Phase-3 detector).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agent-jobs.reconciler-verify-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { partitionPhasesByVerifyVerdict } from "./agent-jobs";

type PhaseShape = { position: number; status: string };

test("verifier=pass on all phases → every phase stamped (the healthy squash-merge recovery)", () => {
  const unshipped: PhaseShape[] = [
    { position: 1, status: "in_progress" },
    { position: 2, status: "planned" },
  ];
  const verdicts = [
    { accumulated: true, reason: "1 grep check(s) passed" },
    { accumulated: true, reason: "2 grep check(s) passed" },
  ];
  const r = partitionPhasesByVerifyVerdict(unshipped, verdicts);
  assert.deepEqual(r.verified.map((p) => p.position), [1, 2]);
  assert.deepEqual(r.refused, []);
});

test("verifier=fail on one phase → that phase REFUSED, others stamped (the phantom-ship class)", () => {
  const unshipped: PhaseShape[] = [
    { position: 1, status: "in_progress" },
    { position: 2, status: "in_progress" }, // phantom: sibling's merge_sha copied but code absent
    { position: 3, status: "planned" },
  ];
  const verdicts = [
    { accumulated: true, reason: "grep check passed" },
    { accumulated: false, reason: 'phase 2 check "getFactorRollup" failed on abc123: no match (expect=present)' },
    { accumulated: true, reason: "grep check passed" },
  ];
  const r = partitionPhasesByVerifyVerdict(unshipped, verdicts);
  assert.deepEqual(r.verified.map((p) => p.position), [1, 3], "only verified phases are stamped");
  assert.deepEqual(r.refused, [{ position: 2, reason: verdicts[1].reason }]);
});

test("verifier=fail on all phases → nothing stamped (the whole spec is a phantom — leave for Phase-3 detector)", () => {
  const unshipped: PhaseShape[] = [
    { position: 1, status: "in_progress" },
    { position: 2, status: "in_progress" },
  ];
  const verdicts = [
    { accumulated: false, reason: "grep failed" },
    { accumulated: false, reason: "grep failed" },
  ];
  const r = partitionPhasesByVerifyVerdict(unshipped, verdicts);
  assert.deepEqual(r.verified, []);
  assert.equal(r.refused.length, 2);
});

test("verdict missing for a position → REFUSED (fail closed — a missing verdict is not permission to stamp)", () => {
  const unshipped: PhaseShape[] = [
    { position: 1, status: "in_progress" },
    { position: 2, status: "in_progress" },
    { position: 3, status: "in_progress" },
  ];
  // simulate an under-sized verdicts array (upstream promise dropped) — the guard must fail closed for 2/3
  const verdicts = [{ accumulated: true, reason: "ok" }] as { accumulated: boolean; reason: string }[];
  const r = partitionPhasesByVerifyVerdict(unshipped, verdicts);
  assert.deepEqual(r.verified.map((p) => p.position), [1]);
  assert.equal(r.refused.length, 2);
  assert.equal(r.refused[0].position, 2);
  assert.match(r.refused[0].reason, /no verdict returned — fail closed/);
});

test("empty unshipped list → empty partition (idempotent no-op — a fully-shipped spec)", () => {
  assert.deepEqual(partitionPhasesByVerifyVerdict([], []), { verified: [], refused: [] });
});

test("partition is order-preserving (positions come out in unshipped-input order)", () => {
  const unshipped: PhaseShape[] = [
    { position: 5, status: "in_progress" },
    { position: 3, status: "in_progress" },
    { position: 8, status: "in_progress" },
  ];
  const verdicts = [
    { accumulated: true, reason: "" },
    { accumulated: true, reason: "" },
    { accumulated: false, reason: "no match" },
  ];
  const r = partitionPhasesByVerifyVerdict(unshipped, verdicts);
  assert.deepEqual(r.verified.map((p) => p.position), [5, 3]);
  assert.deepEqual(r.refused.map((x) => x.position), [8]);
});
