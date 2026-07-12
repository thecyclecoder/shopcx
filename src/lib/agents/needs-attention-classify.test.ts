/**
 * Unit tests for the board-first short-circuit in needs-attention-classify
 * (park-classifier-trust-board-shipped Phase 1).
 *
 * Run: `tsx --test src/lib/agents/needs-attention-classify.test.ts`. Built-in `node:test` — no
 * runner dependency. Covers the pure decision helper (`classifyByBoardState`) + the integration
 * point (`classifyNeedsAttention` runs the board check BEFORE the verdict-string heuristic).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_STYLE_KINDS,
  classifyByBoardState,
  classifyByHeuristic,
  classifyNeedsAttention,
  type ClassifyInput,
} from "./needs-attention-classify";

const PARK_REASON_HEURISTIC_WOULD_MISS =
  "Phase 1 was already built end-to-end in #315 — this was a self-watch gate-lift, not a feature delta";

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    jobKind: "build",
    specSlug: "park-classifier-trust-board-shipped",
    error: PARK_REASON_HEURISTIC_WOULD_MISS,
    logTail: null,
    agentSummary: null,
    ...over,
  };
}

test("BUILD_STYLE_KINDS covers the spec-targeted build-style kinds", () => {
  for (const kind of ["build", "regression", "repair"]) {
    assert.equal(BUILD_STYLE_KINDS.has(kind), true, `expected ${kind} in BUILD_STYLE_KINDS`);
  }
  for (const kind of ["plan", "fold", "spec-test", "triage-escalations", "dev-ask"]) {
    assert.equal(BUILD_STYLE_KINDS.has(kind), false, `expected ${kind} NOT in BUILD_STYLE_KINDS`);
  }
});

test("classifyByBoardState short-circuits a build whose board says shipped → already_shipped", () => {
  const result = classifyByBoardState(baseInput({ boardStatus: "shipped" }));
  assert.ok(result, "expected a classification result");
  assert.equal(result.klass, "already_shipped");
  assert.equal(result.source, "heuristic");
});

test("classifyByBoardState fires for regression + repair builds too", () => {
  for (const jobKind of ["regression", "repair"]) {
    const result = classifyByBoardState(baseInput({ jobKind, boardStatus: "shipped" }));
    assert.ok(result, `expected a result for kind=${jobKind}`);
    assert.equal(result.klass, "already_shipped");
  }
});

test("classifyByBoardState skips non-build-style kinds even when board says shipped", () => {
  for (const jobKind of ["plan", "fold", "spec-test"]) {
    assert.equal(classifyByBoardState(baseInput({ jobKind, boardStatus: "shipped" })), null, `kind=${jobKind}`);
  }
});

test("classifyByBoardState skips when board status is not 'shipped'", () => {
  for (const boardStatus of ["planned", "in_progress", "rejected", null, undefined, ""]) {
    assert.equal(
      classifyByBoardState(baseInput({ boardStatus: boardStatus as string | null | undefined })),
      null,
      `boardStatus=${String(boardStatus)}`,
    );
  }
});

test("classifyByBoardState skips when specSlug is missing", () => {
  assert.equal(classifyByBoardState(baseInput({ specSlug: null, boardStatus: "shipped" })), null);
});

test("classifyNeedsAttention runs the board check FIRST — a build with board=shipped routes to already_shipped even when the verdict-string heuristic doesn't recognize the park reason", async () => {
  // Sanity: the verdict alone does NOT match any heuristic — this is what was breaking pre-spec.
  assert.equal(classifyByHeuristic(baseInput()), null, "test fixture must use a verdict the heuristic misses");
  // With board state injected, the integrated classifier picks it up.
  const result = await classifyNeedsAttention(baseInput({ boardStatus: "shipped" }), null);
  assert.equal(result.klass, "already_shipped");
  assert.equal(result.source, "heuristic");
});

test("classifyNeedsAttention preserves heuristic-match behavior when no board status is provided", async () => {
  const result = await classifyNeedsAttention(baseInput({ error: "code already merged on main" }), null);
  assert.equal(result.klass, "already_shipped");
  assert.equal(result.source, "heuristic");
});

// marco-logistics-director-seat Phase 5 fix — a fused pre-merge security review that ended in
// synthesizeMissingEnvelopeStub is a TOOLING_FAILURE (the LLM couldn't produce structured output),
// NOT a real_blocker (the code has no missing prerequisite). The previous ordering matched
// /needs[- ]human/i in REAL_BLOCKER_PATTERNS first, mis-routing the park to a Fix-phase spawn on
// the origin whose diff had no missing prerequisite to build. Adding a specific TOOLING_FAILURE
// pattern for the envelope-missing failure mode routes it to auto-spec-tooling-fix — the correct
// destination for an LLM-output failure — and prevents the same `blocker:real_blocker` check_key
// from reappearing on the origin's next spec_test_runs row after this Fix phase ships.
test("classifyByHeuristic routes a fused-session missing-security-envelope failure to tooling_failure", () => {
  const result = classifyByHeuristic({
    jobKind: "security-review",
    specSlug: "marco-logistics-director-seat",
    error: "needs-human",
    logTail:
      "Fused session did not emit a security envelope: fused session did not emit a security envelope after one repair retry. Held for a human review (no auto-clean bypass).",
    agentSummary: null,
  });
  assert.ok(result, "expected a heuristic classification result");
  assert.equal(result.klass, "tooling_failure");
  assert.equal(result.source, "heuristic");
});

test("classifyByHeuristic routes the bare-envelope-missing classifier reason to tooling_failure", () => {
  const result = classifyByHeuristic({
    jobKind: "security-review",
    specSlug: "any-spec",
    error: "needs-human",
    logTail: "no security envelope on the fused spec-test result — bare fall-through",
    agentSummary: null,
  });
  assert.ok(result, "expected a heuristic classification result");
  assert.equal(result.klass, "tooling_failure");
});
