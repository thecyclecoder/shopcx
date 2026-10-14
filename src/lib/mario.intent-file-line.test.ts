import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFileLineRefsFromIntent } from "./mario";
import { assertIntentIsPlainLanguage } from "./author-spec";

// 2026-10-13: two Mario durable fix specs were dropped because their `why` cited file:line refs.
test("stripFileLineRefsFromIntent keeps the file name and drops the line suffix", () => {
  const why = "The unit_test executor (src/lib/spec-check-runner.ts:565) runs with no baseline, unlike scripts/builder-worker.ts:4270-4290.";
  const out = stripFileLineRefsFromIntent(why);
  assert.equal(out, "The unit_test executor (src/lib/spec-check-runner.ts) runs with no baseline, unlike scripts/builder-worker.ts.");
  assert.doesNotThrow(() => assertIntentIsPlainLanguage("s", "why", out));
  assert.throws(() => assertIntentIsPlainLanguage("s", "why", why));
});

test("stripFileLineRefsFromIntent leaves prose without refs untouched", () => {
  const why = "Builds wedge when main is red at 10:30 on a ratio of 3:1.";
  assert.equal(stripFileLineRefsFromIntent(why), why);
});
