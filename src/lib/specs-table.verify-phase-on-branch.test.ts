/**
 * Unit tests for `verifyPhaseAccumulatedOnBranch`
 * ([[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]] Phase 1).
 *
 * Pins the correct state per the spec's Phase-1 Verification bullet:
 *   "eyeball: a status=shipped phase with absent code now reads NOT accumulated"
 *
 * The verifier reads the phase's `spec_phase_checks` (exec_kind='grep') and runs each against
 * `branchRef` via git grep — a status flag alone is NOT sufficient. Deps are injected so the tests
 * exercise the policy without touching git / Supabase.
 *
 * Run:
 *   npx tsx --test src/lib/specs-table.verify-phase-on-branch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyPhaseAccumulatedOnBranch,
  type PhaseFlagsForVerify,
  type VerifyPhaseDeps,
} from "@/lib/specs-table";
import type { GrepCheckParams } from "@/lib/spec-phase-checks-table";

const WS = "00000000-0000-0000-0000-000000000000";
const SLUG = "some-spec";
const BRANCH = "claude/build-some-spec";

function makeDeps(overrides: Partial<VerifyPhaseDeps>): VerifyPhaseDeps {
  return {
    loadPhaseFlags: async () => null,
    loadPhaseGrepChecks: async () => [],
    runGitGrepOnBranch: async () => ({ ok: true, evidence: "unused" }),
    ...overrides,
  };
}

test("shipped phase whose grep-checked code is ABSENT on branch reads NOT accumulated (the phantom-ship class)", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "shipped", build_sha: "deadbeef" };
  const grep: GrepCheckParams = { pattern: "getFactorRollup", path: "src/lib/factor-rollup-sdk.ts", expect: "present" };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [{ description: "getFactorRollup is exported", params: grep }],
    // Simulate git grep returning "no match" for the required pattern (the phantom-ship case: status=shipped,
    // build_sha stamped, but the code never landed on the branch).
    runGitGrepOnBranch: async () => ({ ok: false, evidence: "git grep 'getFactorRollup' — no match (expect=present)" }),
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 2, BRANCH, deps);
  assert.equal(verdict.accumulated, false, "shipped-but-code-absent must NOT be accumulated");
  assert.match(verdict.reason, /getFactorRollup/);
  assert.match(verdict.reason, /no match/);
});

test("phase whose grep checks ALL pass on branch reads accumulated", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "in_progress", build_sha: null };
  const grep: GrepCheckParams = { pattern: "verifyPhaseAccumulatedOnBranch", expect: "present" };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [{ description: "verifier is exported", params: grep }],
    runGitGrepOnBranch: async () => ({ ok: true, evidence: "match(es) found" }),
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, true);
  assert.match(verdict.reason, /1 grep check\(s\) passed/);
});

test("phase not found in the spec fails CLOSED (not accumulated) — the pre-P1 fail-open path is gone", async () => {
  const deps = makeDeps({ loadPhaseFlags: async () => null });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 99, BRANCH, deps);
  assert.equal(verdict.accumulated, false);
  assert.match(verdict.reason, /not found/);
});

test("a thrown loader fails CLOSED — no fail-open on read errors", async () => {
  const deps = makeDeps({
    loadPhaseFlags: async () => { throw new Error("supabase pool timeout"); },
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, false);
  assert.match(verdict.reason, /fail closed/);
  assert.match(verdict.reason, /supabase pool timeout/);
});

test("phase with NO grep checks falls back to terminal-status flag (best effort during migration window)", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "shipped", build_sha: "abc" };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [],
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, true, "legacy phase (no grep checks) trusts the status flag");
  assert.match(verdict.reason, /no grep checks/);
});

test("phase with NO grep checks AND no terminal flag is NOT accumulated", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "planned", build_sha: null };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [],
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, false);
});

test("verifier rejects context with missing workspace/slug/branchRef (fail closed)", async () => {
  const deps = makeDeps({});
  const a = await verifyPhaseAccumulatedOnBranch("", SLUG, 1, BRANCH, deps);
  assert.equal(a.accumulated, false);
  const b = await verifyPhaseAccumulatedOnBranch(WS, "", 1, BRANCH, deps);
  assert.equal(b.accumulated, false);
  const c = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, "", deps);
  assert.equal(c.accumulated, false);
});
