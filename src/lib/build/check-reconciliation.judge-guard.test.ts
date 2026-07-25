/**
 * Unit tests for `reconcileStaleGrepCheck` — the deterministic grep is the safety gate,
 * for BOTH step A and step B ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]]
 * Phase 1). Step B now AUTO-APPLIES a confident judge proposal (a non-null literal whose
 * final deterministic grep on the branch passes) — the file's original "judge NEVER auto-
 * reconciles" invariant is retired; the residual prompt-injection risk is bounded by the
 * per-build cap + the `check_reconciled` director_activity audit (every repoint surfaced).
 *
 *   npx tsx --test src/lib/build/check-reconciliation.judge-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileStaleGrepCheck, type ReconcileDeps, type FailingGrepCheck } from "./check-reconciliation";

const CHECK: FailingGrepCheck = {
  phaseId: "p1",
  phasePosition: 1,
  checkPosition: 1,
  description: "the reconciler is wired into the verify path",
  params: { pattern: "reconcileStaleGrepCheck", path: "scripts/builder-worker.ts", expect: "present" },
};

function deps(over: Partial<ReconcileDeps>): ReconcileDeps {
  return {
    normalizedGrep: async () => ({ matchedLiteral: null, evidence: "no normalized match" }),
    loadPhaseDiff: async () => "+ // some diff for the path\n+ const x = 1;",
    intentJudge: async () => ({ literal: null, rationale: "no" }),
    runDeterministicGrep: async () => ({ ok: false, evidence: "no match" }),
    ...over,
  };
}

test("judge proposes a literal whose deterministic grep passes → AUTO-APPLIED (judge_repoint_auto_applied)", async () => {
  // The rename wedge: `fitTextToBox` was renamed to `fitFontToBox`. The judge maps the
  // description-intent to the new literal and the deterministic grep confirms it's present
  // on the branch — the reconciler auto-repoints instead of escalating to a human.
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: "fitFontToBox", rationale: "renamed from fitTextToBox — same intent" }),
      runDeterministicGrep: async () => ({ ok: true, evidence: "grep matched (new literal)" }),
    }),
  });
  assert.equal(out.reconciled, true);
  if (out.reconciled === true) {
    assert.equal(out.step, "judge_repoint_auto_applied");
    assert.equal(out.newPattern, "fitFontToBox");
    assert.match(out.rationale, /judge_repoint_auto_applied/);
  }
});

test("judge proposes a literal but the deterministic grep FAILS → not reconciled (proposal_did_not_match)", async () => {
  // The deterministic grep is the safety gate: a judge proposal that doesn't actually match
  // the branch never lands.
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: "fabricatedSymbol", rationale: "guessing" }),
      runDeterministicGrep: async () => ({ ok: false, evidence: "no match on branch" }),
    }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) {
    assert.match(out.reason, /proposal_did_not_match/);
    assert.match(out.evidence ?? "", /fabricatedSymbol/);
  }
});

test("step A (deterministic normalized re-match) still auto-reconciles", async () => {
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      normalizedGrep: async () => ({ matchedLiteral: "reconcileStaleGrepCheck", evidence: "normalized hit" }),
      runDeterministicGrep: async () => ({ ok: true, evidence: "re-grep ok" }),
    }),
  });
  assert.equal(out.reconciled, true);
  if (out.reconciled === true) assert.equal(out.step, "normalized_case");
});

test("judge declines (no literal) → unreconciled judge_declined, no auto-apply", async () => {
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({ intentJudge: async () => ({ literal: null, rationale: "intent not met" }) }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) assert.match(out.reason, /judge_declined/);
});
