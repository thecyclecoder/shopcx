/**
 * Unit tests for the grader rubric's severity distinction.
 * `escalation-keys-on-real-severity-not-a-middling-score-minor-issue-on-resolved-ticket-stays-closed`
 * Phase 1: a resolved ticket whose sole fault is a minor accuracy/style note
 * scores in the good-enough band (~6-8), NOT ≤5 — only a factual inaccuracy
 * that actually failed the customer hits the ≤5 cap. Pins the rubric text
 * that the grader consumes.
 *
 * Built-in node:test — run:
 *   npx tsx --test src/lib/ticket-analyzer.rubric.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GRADER_RUBRIC_BODY } from "./ticket-analyzer";

test("rubric has a severity-aware HARD CAPS block (not a single flat inaccuracy cap)", () => {
  assert.ok(
    /HARD CAPS \(severity-aware/i.test(GRADER_RUBRIC_BODY),
    "HARD CAPS block must be labelled severity-aware",
  );
});

test("failed-customer inaccuracy still caps at 5", () => {
  const line = GRADER_RUBRIC_BODY
    .split("\n")
    .find(l => /FAILED the customer/i.test(l) && /max score 5/i.test(l));
  assert.ok(
    line,
    "the ≤5 cap must be scoped to a factual inaccuracy that FAILED the customer",
  );
});

test("minor-note-on-otherwise-correct-resolution caps at 7, not 5", () => {
  const line = GRADER_RUBRIC_BODY
    .split("\n")
    .find(l => /minor accuracy\/style note/i.test(l) && /otherwise-correct resolution/i.test(l));
  assert.ok(line, "the minor-note cap must be present and scoped to a resolved ticket");
  assert.ok(/max score 7/i.test(line!), "the minor-note cap must be 7");
  assert.ok(
    !/max score [1-5]\b/i.test(line!),
    "the minor-note case must not fall into the ≤5 severe band",
  );
});

test("scoring band 6-7 explicitly covers a resolved ticket with a minor accuracy note", () => {
  const line = GRADER_RUBRIC_BODY
    .split("\n")
    .find(l => /^\s*6-7/.test(l));
  assert.ok(line, "the 6-7 band description must exist");
  assert.ok(
    /minor accuracy\/style note/i.test(line!),
    "the 6-7 band must explicitly include the resolved-ticket minor-note case",
  );
  assert.ok(
    /did not mislead or fail the customer/i.test(line!),
    "the 6-7 band must qualify the minor-note case with the did-not-mislead predicate",
  );
});

test("scoring band 4-5 restricts inaccuracy to one that misled the customer", () => {
  const line = GRADER_RUBRIC_BODY
    .split("\n")
    .find(l => /^\s*4-5/.test(l));
  assert.ok(line, "the 4-5 band description must exist");
  assert.ok(
    /misled the customer|led to a wrong action/i.test(line!),
    "the 4-5 band must scope the accuracy penalty to a misleading/harmful inaccuracy",
  );
});

test("rubric names the decision rule the grader must apply", () => {
  assert.ok(
    /did this inaccuracy actually fail the customer/i.test(GRADER_RUBRIC_BODY),
    "the rubric must ask the grader to distinguish failed-customer from coaching-only",
  );
  assert.ok(
    /coaching-only/i.test(GRADER_RUBRIC_BODY),
    "the rubric must name the coaching-only branch of the decision",
  );
});

test("rubric preserves the unkept-promise cap at 4 and the repetition cap at 5", () => {
  const promise = GRADER_RUBRIC_BODY
    .split("\n")
    .find(l => /unkept promise/i.test(l));
  assert.ok(promise && /max score 4/i.test(promise), "unkept-promise cap must remain at 4");

  const repeat = GRADER_RUBRIC_BODY
    .split("\n")
    .find(l => /repeated identical response/i.test(l));
  assert.ok(repeat && /max score 5/i.test(repeat), "repetition cap must remain at 5");
});
