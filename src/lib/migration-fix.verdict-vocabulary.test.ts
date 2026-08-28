/**
 * migration-audit-immediate-charge-races-the-order-now-retry Phase 2 — pins the accepted terminal-verdict
 * vocabulary the migration-fix lane branches on. code_gap is a RECOGNIZED, REPORTED terminal outcome; the
 * ground-truth failure this pins was audit ecf8e8fc (Denise Butler, sub 549c234d, 2026-08-18) whose
 * migration-fix session correctly emitted `code_gap` (session_note: "Emitting code_gap verdict — no
 * retry_charge fix_kind + no auto-reverify path"), but the parked job ended `error='migration-fix ended
 * without propose/human_needed'` because the acceptance lane didn't list code_gap — a park backstop that
 * told the founder "you can't fix this from this card" while DISCARDING the actual finding.
 *
 * The vocabulary + type-guard is the source-of-truth the worker's fallback branch derives its error
 * message from (scripts/builder-worker.ts imports RECOGNIZED_MIGRATION_FIX_VERDICTS +
 * isRecognisedMigrationFixVerdict). Adding a new verdict to the array is now the SINGLE point of change.
 *
 *   npx tsx --test src/lib/migration-fix.verdict-vocabulary.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECOGNIZED_MIGRATION_FIX_VERDICTS,
  isRecognisedMigrationFixVerdict,
} from "./migration-fix";

test("code_gap is in the recognized vocabulary alongside propose / needs_input / human_needed", () => {
  assert.deepEqual([...RECOGNIZED_MIGRATION_FIX_VERDICTS].sort(), [
    "code_gap",
    "human_needed",
    "needs_input",
    "propose",
  ]);
});

test("every recognized verdict passes the type-guard", () => {
  for (const v of RECOGNIZED_MIGRATION_FIX_VERDICTS) {
    assert.equal(isRecognisedMigrationFixVerdict(v), true, `expected ${v} recognised`);
  }
});

test("code_gap specifically is a recognised terminal verdict (the anti-pattern this pins)", () => {
  assert.equal(isRecognisedMigrationFixVerdict("code_gap"), true);
});

test("an unknown status (e.g. an old typo, or a future verdict not yet added) is NOT recognised", () => {
  assert.equal(isRecognisedMigrationFixVerdict("propose_v2"), false);
  assert.equal(isRecognisedMigrationFixVerdict("failed"), false);
  assert.equal(isRecognisedMigrationFixVerdict("ok"), false);
  assert.equal(isRecognisedMigrationFixVerdict(""), false);
});

test("a non-string status (agent returned no JSON) is NOT recognised", () => {
  assert.equal(isRecognisedMigrationFixVerdict(undefined), false);
  assert.equal(isRecognisedMigrationFixVerdict(null), false);
  assert.equal(isRecognisedMigrationFixVerdict(42), false);
  assert.equal(isRecognisedMigrationFixVerdict({}), false);
});

test("the fallback error message names EVERY recognised verdict (no drift from the array)", () => {
  const msg = `migration-fix ended without a recognised terminal verdict (${RECOGNIZED_MIGRATION_FIX_VERDICTS.join(" | ")})`;
  for (const v of RECOGNIZED_MIGRATION_FIX_VERDICTS) {
    assert.ok(msg.includes(v), `fallback message must include ${v}`);
  }
  assert.ok(msg.includes("code_gap"), "fallback message must include code_gap");
});
