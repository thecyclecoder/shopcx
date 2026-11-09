/**
 * Unit tests for the ship-time-backfill detector's test-file exclusion —
 * ship-time-backfill-executor-passes-apply Phase 1.
 *
 * The bug: `isBackfillScriptPath`'s regex `^scripts/_backfill-…\.ts$` also matched a
 * `_backfill-foo.test.ts` companion (the `.test` is just more `[a-z0-9._-]`), so the post-merge
 * detector ledgered unit-test files as `pending` backfills — two phantom `data_op_runs` rows
 * exist on main. These tests pin the exclusion of `*.test.ts` / `*.spec.ts`.
 *
 * Run:  npx tsx --test src/lib/ship-time-backfill-detector.test-files.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isBackfillScriptPath,
  isTestFileScriptPath,
} from "./ship-time-backfill-detector";

test("a *.test.ts companion of a backfill is NOT a backfill to ledger", () => {
  assert.equal(isBackfillScriptPath("scripts/_backfill-foo.test.ts"), false);
  assert.equal(isBackfillScriptPath("scripts/_backfill-foo.spec.ts"), false);
  // The two phantom rows that exist on main today — both must now be rejected.
  assert.equal(
    isBackfillScriptPath(
      "scripts/_backfill-migration-audit-immediate-charge-false-failures.test.ts",
    ),
    false,
  );
  assert.equal(
    isBackfillScriptPath("scripts/_backfill-renewal-free-shipping-refunds.test.ts"),
    false,
  );
});

test("a genuine backfill / ledger-reconcile script still passes", () => {
  assert.equal(isBackfillScriptPath("scripts/_backfill-foo.ts"), true);
  assert.equal(
    isBackfillScriptPath("scripts/_backfill-renewal-free-shipping-refunds.ts"),
    true,
  );
  assert.equal(
    isBackfillScriptPath("scripts/_ledger-reconcile-20261124120000.ts"),
    true,
  );
});

test("isTestFileScriptPath flags exactly the test/spec companions", () => {
  assert.equal(isTestFileScriptPath("scripts/_backfill-foo.test.ts"), true);
  assert.equal(isTestFileScriptPath("scripts/_backfill-foo.spec.ts"), true);
  assert.equal(isTestFileScriptPath("scripts/_backfill-foo.ts"), false);
});

test("paths outside the bounded convention are still rejected (rails intact)", () => {
  assert.equal(isBackfillScriptPath("scripts/other-foo.ts"), false);
  assert.equal(isBackfillScriptPath("scripts/_backfill-.ts"), false);
  assert.equal(isBackfillScriptPath("../scripts/_backfill-foo.ts"), false);
});
