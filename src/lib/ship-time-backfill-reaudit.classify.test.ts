/**
 * Unit tests for the Phase-2 re-audit classifiers —
 * ship-time-backfill-executor-passes-apply Phase 2.
 *
 * The "flip vs leave vs escalate" fork is the whole judgment of the re-audit pass. These pin it:
 *   - a positive would-write COUNT ⇒ pending (reset + re-drain), even alongside a `no-op=` label.
 *   - an explicit no-op signal with no positive count ⇒ noop (leave `ran`).
 *   - prose with no clean count or no-op (a surgical one-off) ⇒ ambiguous (escalate to the founder).
 *
 * Run:  npx tsx --test src/lib/ship-time-backfill-reaudit.classify.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  scriptHasApplyGate,
  classifyReauditDryRun,
} from "./ship-time-backfill-reaudit";

test("scriptHasApplyGate detects the --apply argv gate and the APPLY env gate", () => {
  assert.equal(
    scriptHasApplyGate(`const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";`),
    true,
  );
  assert.equal(scriptHasApplyGate(`if (process.env.APPLY === "1") write();`), true);
  // A script with NO gate (always writes) is not apply-gated — it must be left `ran`.
  assert.equal(scriptHasApplyGate(`await writeEverythingUnconditionally();`), false);
  assert.equal(scriptHasApplyGate(""), false);
});

test("a structured would-write count > 0 ⇒ pending, even when a `no-op=` label is also present", () => {
  assert.equal(classifyReauditDryRun("result: scanned=5 no-op=2 would-write=3 (dry-run)"), "pending");
  assert.equal(classifyReauditDryRun("  would update 7 rows"), "pending");
  assert.equal(classifyReauditDryRun("would insert 2 coupons"), "pending");
});

test("an explicit no-op signal with no positive count ⇒ noop (leave ran)", () => {
  assert.equal(classifyReauditDryRun("result: scanned=5 no-op=5 would-write=0 (dry-run)"), "noop");
  assert.equal(classifyReauditDryRun("nothing to do"), "noop");
  assert.equal(classifyReauditDryRun("matched 0 rows, would update 0"), "noop");
  assert.equal(classifyReauditDryRun("scanned=0 — no targets"), "noop");
});

test("prose with no clean count or no-op ⇒ ambiguous (surgical one-off → escalate)", () => {
  assert.equal(classifyReauditDryRun("would insert Brittany's loyalty coupon 46a7aa75"), "ambiguous");
  assert.equal(classifyReauditDryRun("DRY-RUN\n  inspecting customer renea@example.com"), "ambiguous");
  assert.equal(classifyReauditDryRun(""), "ambiguous");
});
