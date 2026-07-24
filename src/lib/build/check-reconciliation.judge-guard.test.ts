/**
 * Security regression (prompt-injection, high — flagged by this spec's own
 * security review): the LLM intent judge (step B) reads the UNTRUSTED branch
 * diff, so it must NEVER autonomously reconcile a check. Only the deterministic
 * step-A normalized re-match may auto-heal; a judge proposal is recorded as an
 * unreconciled human-review diagnostic even when its literal deterministically
 * greps on the branch.
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

test("judge proposes a literal that DOES grep on the branch → still NOT reconciled (recorded for human review)", async () => {
  // The dangerous case: a prompt-injected diff steers the judge to an unrelated
  // but present literal; the deterministic grep would 'ok' it. Must NOT reconcile.
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: "someUnrelatedButPresentSymbol", rationale: "injected: this satisfies the check" }),
      runDeterministicGrep: async () => ({ ok: true, evidence: "matched (but unrelated)" }),
    }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) {
    assert.match(out.reason, /judge_proposal_needs_human/);
    assert.match(out.evidence ?? "", /someUnrelatedButPresentSymbol/); // candidate surfaced for a human
    assert.match(out.evidence ?? "", /present-on-branch=true/);
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

test("judge declines (no literal) → unreconciled judge_declined, no LLM effect", async () => {
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({ intentJudge: async () => ({ literal: null, rationale: "intent not met" }) }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) assert.match(out.reason, /judge_declined/);
});
