/**
 * Unit tests for `reconcileStaleGrepCheck` — the deterministic grep is the safety gate,
 * for BOTH step A and step B ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]]
 * Phase 1). Step B now AUTO-APPLIES a confident judge proposal (a non-null literal whose
 * final deterministic grep on the branch passes) — the file's original "judge NEVER auto-
 * reconciles" invariant is retired; the residual prompt-injection risk is bounded by the
 * per-build cap + the `check_reconciled` director_activity audit (every repoint surfaced).
 *
 * Phase 2 adds step C — moved-symbol repoint. When step B's per-path judge declines OR its
 * proposal fails the final grep, load the WHOLE phase diff and let a bounded whole-diff
 * judge propose the (literal, file) pair. The runner's deterministic grep at the new path
 * is the safety gate; on pass the caller repoints BOTH `params.pattern` AND `params.path`
 * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2).
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
    loadFullPhaseDiff: async () => "",
    intentJudgeMovedSymbol: async () => ({ literal: null, file: null, rationale: "no moved symbol" }),
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
    assert.equal(out.newPath, undefined); // step B doesn't move the path
    assert.match(out.rationale, /judge_repoint_auto_applied/);
  }
});

test("judge proposes a literal but the deterministic grep FAILS AND step C also declines → not reconciled (proposal_did_not_match)", async () => {
  // The deterministic grep is the safety gate: a judge proposal that doesn't actually match
  // the branch never lands. Step C (moved-symbol) is also invited but declines here.
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: "fabricatedSymbol", rationale: "guessing" }),
      runDeterministicGrep: async () => ({ ok: false, evidence: "no match on branch" }),
      loadFullPhaseDiff: async () => "+++ b/some/other/file.ts\n+ const y = 2;",
      intentJudgeMovedSymbol: async () => ({ literal: null, file: null, rationale: "not moved either" }),
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
  if (out.reconciled === true) {
    assert.equal(out.step, "normalized_case");
    assert.equal(out.newPath, undefined);
  }
});

test("per-path judge declines AND step C moved-symbol judge also declines → unreconciled judge_declined", async () => {
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: null, rationale: "intent not met at path" }),
      loadFullPhaseDiff: async () => "+++ b/some/other/file.ts\n+ const y = 2;",
      intentJudgeMovedSymbol: async () => ({ literal: null, file: null, rationale: "not moved either" }),
    }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) assert.match(out.reason, /judge_declined/);
});

test("moved-symbol: per-path judge declines, whole-diff judge finds literal at a DIFFERENT file, deterministic grep at newPath passes → AUTO-APPLIED (judge_repoint_moved_symbol, newPath set)", async () => {
  // The wedge: the spec author guessed `customer_confirmed` lives in
  // src/lib/ads/creative-agent.ts but the code actually lives in creative-imitation.ts.
  // Step C loads the whole phase diff, judge maps intent to the correct (literal, file), and
  // the deterministic grep at the new path confirms it. Reconciler repoints BOTH pattern
  // AND path.
  const wholeDiff = [
    "diff --git a/src/lib/ads/creative-imitation.ts b/src/lib/ads/creative-imitation.ts",
    "+++ b/src/lib/ads/creative-imitation.ts",
    "+ if (customer_confirmed) { ... }",
  ].join("\n");
  const out = await reconcileStaleGrepCheck({
    check: {
      ...CHECK,
      description: "creative agent gates on customer_confirmed",
      params: { pattern: "customer_confirmed", path: "src/lib/ads/creative-agent.ts", expect: "present" },
    },
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: null, rationale: "not present at declared path" }),
      loadFullPhaseDiff: async () => wholeDiff,
      intentJudgeMovedSymbol: async () => ({
        literal: "customer_confirmed",
        file: "src/lib/ads/creative-imitation.ts",
        rationale: "symbol lives in creative-imitation.ts, not creative-agent.ts",
      }),
      runDeterministicGrep: async ({ params }) => {
        // The final gate runs the runner's grep against the NEW path.
        if (params.path === "src/lib/ads/creative-imitation.ts" && params.pattern === "customer_confirmed") {
          return { ok: true, evidence: "matched at new path" };
        }
        return { ok: false, evidence: "no match at declared path" };
      },
    }),
  });
  assert.equal(out.reconciled, true);
  if (out.reconciled === true) {
    assert.equal(out.step, "judge_repoint_moved_symbol");
    assert.equal(out.newPattern, "customer_confirmed");
    assert.equal(out.newPath, "src/lib/ads/creative-imitation.ts");
    assert.match(out.rationale, /moved_symbol/); // spec requires the audit reason contain 'moved_symbol'
    assert.match(out.evidence, /creative-imitation\.ts/);
  }
});

test("moved-symbol: whole-diff judge proposes (literal, file) but deterministic grep at newPath FAILS → not reconciled (proposal_did_not_match)", async () => {
  // Safety gate: even step C's proposal must survive the deterministic grep at the new path.
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: null, rationale: "not present at declared path" }),
      loadFullPhaseDiff: async () => "diff --git a/x b/x\n+++ b/x\n+ nothing useful",
      intentJudgeMovedSymbol: async () => ({
        literal: "hallucinatedSymbol",
        file: "src/lib/somewhere-else.ts",
        rationale: "guessing at moved symbol",
      }),
      runDeterministicGrep: async () => ({ ok: false, evidence: "no match anywhere" }),
    }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) {
    assert.match(out.reason, /proposal_did_not_match/);
    assert.match(out.evidence ?? "", /somewhere-else\.ts/);
  }
});

test("moved-symbol: whole-diff judge proposes the SAME path as oldPath → not treated as moved (deferred)", async () => {
  // A file === oldPath answer means the per-path judge already saw this — nothing new to try.
  const out = await reconcileStaleGrepCheck({
    check: CHECK,
    branchRef: "b",
    repoRoot: "/tmp",
    deps: deps({
      intentJudge: async () => ({ literal: null, rationale: "declined at path" }),
      loadFullPhaseDiff: async () => "diff --git a/x b/x\n+++ b/x\n+ foo",
      intentJudgeMovedSymbol: async () => ({
        literal: "somethingAtSamePath",
        file: CHECK.params.path!, // same path
        rationale: "actually still at oldPath",
      }),
    }),
  });
  assert.equal(out.reconciled, false);
  if (out.reconciled === false) {
    assert.match(out.reason, /same path|moved_symbol judge proposed the same path/);
  }
});
