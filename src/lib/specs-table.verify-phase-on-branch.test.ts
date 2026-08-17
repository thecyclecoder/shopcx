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

// ── Phase 2: an unresolvable ref is its own outcome, not a failed check ──────────────────────────
//
// Pins the correct state per the spec's Phase-2 Verification bullet:
//   "an unresolvable branch ref is reported as its own outcome"
//
// The gate must FAIL CLOSED (never green-light without reading the artifact), and the reason
// surfaced by the verifier must clearly name the class as an infrastructure fault — never as a
// phantom "code missing" — so an operator sees the right thing to fix.

test("unresolvable ref is reported distinctly from a no-match — reason names 'unresolvable', carries the git error verbatim, fails closed", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "in_progress", build_sha: null };
  const grep: GrepCheckParams = { pattern: "someSymbol", expect: "present" };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [{ description: "someSymbol exists", params: grep }],
    // Simulate the resolver failing — the fetch (or rev-parse) of `origin/<branch>` came back
    // with a git error. The runGitGrepOnBranch shim tags the result with the distinct outcome.
    runGitGrepOnBranch: async () => ({
      ok: false,
      outcome: "unresolvable",
      evidence: "unresolvable remote-tracking ref for 'claude/build-some-spec': git fetch origin claude/build-some-spec: fatal: couldn't find remote ref",
      gitError: "fatal: couldn't find remote ref refs/heads/claude/build-some-spec",
    }),
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, false, "unresolvable ref MUST fail closed — never green-light a check we could not read");
  // The reason must clearly frame this as infrastructure, not a phantom code gap.
  assert.match(verdict.reason, /unresolvable/i);
  // The git error itself is carried through so an operator can act on it.
  assert.match(verdict.reason, /couldn't find remote ref/);
  // And crucially — it must NOT read as "the code is missing" like a no-match would.
  assert.doesNotMatch(verdict.reason, /no match/i);
});

test("grep-error (git command failed, not a no-match) is reported distinctly from a no-match — infrastructure, not a code gap", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "in_progress", build_sha: null };
  const grep: GrepCheckParams = { pattern: "someSymbol", expect: "present" };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [{ description: "someSymbol exists", params: grep }],
    // Simulate git grep itself failing (exit != 0/1 — bad regex, corrupt index, etc.).
    runGitGrepOnBranch: async () => ({
      ok: false,
      outcome: "grep-error",
      ref: "origin/claude/build-some-spec",
      evidence: "git grep failed on origin/claude/build-some-spec: fatal: bad revision",
      gitError: "fatal: bad revision",
    }),
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, false);
  // Reason must frame this as an infrastructure fault, not "code missing".
  assert.match(verdict.reason, /git error/i);
  assert.match(verdict.reason, /bad revision/);
  assert.doesNotMatch(verdict.reason, /no match/i);
});

test("a legacy shim (no `outcome` field on the result) still lands as a plain failed check — backwards compatible", async () => {
  const phase: PhaseFlagsForVerify = { id: "phase-1", status: "in_progress", build_sha: null };
  const grep: GrepCheckParams = { pattern: "someSymbol", expect: "present" };
  const deps = makeDeps({
    loadPhaseFlags: async () => phase,
    loadPhaseGrepChecks: async () => [{ description: "someSymbol exists", params: grep }],
    // A shim that only speaks the old `{ ok, evidence }` shape — the verifier must still fail closed
    // and surface the evidence, without pretending it was unresolvable.
    runGitGrepOnBranch: async () => ({ ok: false, evidence: "git grep 'someSymbol' — no match (expect=present)" }),
  });
  const verdict = await verifyPhaseAccumulatedOnBranch(WS, SLUG, 1, BRANCH, deps);
  assert.equal(verdict.accumulated, false);
  assert.match(verdict.reason, /no match/);
  assert.doesNotMatch(verdict.reason, /unresolvable/i);
  assert.doesNotMatch(verdict.reason, /git error/i);
});
