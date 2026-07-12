/**
 * Phase 3 of [[../../../docs/brain/specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] —
 * pin the retirement invariant: `spec-review` MUST NOT appear in `AGENT_RUBRICS` / `GRADEABLE_KINDS` /
 * `gradeableKindsForFunction('platform')`. Vale's LLM lane is retired; the deterministic spec-review
 * gate ([[../../../docs/brain/libraries/spec-review-gate]]) runs synchronously at authoring and is
 * MONITORED infra (Control Tower registry), not a graded worker.
 *
 * Run:
 *   npm run test:agent-grader-spec-review-retired
 *   (= tsx --test src/lib/agents/agent-grader.spec-review-retired.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_RUBRICS, GRADEABLE_KINDS, gradeableKindsForFunction } from "./agent-grader";

test("`spec-review` is NOT in AGENT_RUBRICS (Vale retired → deterministic gate)", () => {
  assert.equal(
    "spec-review" in AGENT_RUBRICS,
    false,
    `AGENT_RUBRICS still lists spec-review; expected the retired-Vale invariant to hold`,
  );
});

test("`spec-review` is NOT in GRADEABLE_KINDS", () => {
  assert.equal(GRADEABLE_KINDS.includes("spec-review"), false);
});

test("Ada's charge (gradeableKindsForFunction('platform')) EXCLUDES spec-review", () => {
  const kinds = gradeableKindsForFunction("platform");
  assert.equal(
    kinds.includes("spec-review"),
    false,
    `expected 'spec-review' out of platform's charge, got: ${kinds.join(", ")}`,
  );
});

test("Ada's charge still includes the un-retired platform workers (build/spec-test/repair)", () => {
  const kinds = gradeableKindsForFunction("platform");
  assert.ok(kinds.includes("build"), `platform should still grade build`);
  assert.ok(kinds.includes("spec-test"), `platform should still grade spec-test`);
  assert.ok(kinds.includes("repair"), `platform should still grade repair`);
});
