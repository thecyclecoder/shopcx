/**
 * autobuild-circuit-break-on-repeated-pre-commit-self-verify-failure Phase 1 — the pure decision behind
 * `enqueueBuildIfDue`'s self-verify breaker. The named failing state: a settled failed build is not
 * in-flight, so an unbuildable autoBuild spec re-queues the identical failing build every tick. The breaker
 * opens only when the TOP N consecutive builds all failed with the SAME self-verify signature; a success, a
 * different failure mode, or an edited spec (new failing checks ⇒ new signature) must reset the streak.
 *
 * Ground truth: close-snapshot-coverage-guard looped >1 month — builds 016fc2bd / 8803225e / 33c1d887 /
 * 7e234f4c / fa28bba0 all failed 'pre-commit self-verify unresolved after 2 repair passes: …' identically.
 *
 * Run: npx tsx --test src/lib/agent-jobs.self-verify-circuit.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSelfVerifySignature,
  selfVerifyCircuitDecision,
  SELF_VERIFY_CIRCUIT_N,
} from "@/lib/agent-jobs";

const failUnit = {
  status: "failed",
  error: "pre-commit self-verify unresolved after 2 repair passes: the registered test suite passes (unit_test)",
};
const failUnitDiffPassCount = {
  status: "failed",
  error: "pre-commit self-verify unresolved after 3 repair passes: the registered test suite passes (unit_test)",
};
const failOtherCheck = {
  status: "failed",
  error: "pre-commit self-verify unresolved after 2 repair passes: export foo exists in bar.ts (grep)",
};
const failTsc = { status: "failed", error: "tsc failed after pre-commit self-verify repair" };
const success = { status: "completed", error: null };

test("signature ignores the repair-pass count but splits on the failing-check list", () => {
  assert.equal(
    deriveSelfVerifySignature(failUnit.error),
    deriveSelfVerifySignature(failUnitDiffPassCount.error),
    "same failing checks, different pass count → same signature",
  );
  assert.notEqual(deriveSelfVerifySignature(failUnit.error), deriveSelfVerifySignature(failOtherCheck.error));
  assert.equal(deriveSelfVerifySignature(failTsc.error), null, "a tsc regression is not a self-verify-unresolved signature");
  assert.equal(deriveSelfVerifySignature(null), null);
});

test(`circuit OPENS at ${SELF_VERIFY_CIRCUIT_N} consecutive identical self-verify failures (the close-snapshot loop)`, () => {
  const rows = Array.from({ length: SELF_VERIFY_CIRCUIT_N }, () => ({ ...failUnit }));
  const d = selfVerifyCircuitDecision(rows);
  assert.equal(d.open, true);
  assert.equal(d.count, SELF_VERIFY_CIRCUIT_N);
  assert.ok(d.signature);
});

test(`circuit STAYS CLOSED below ${SELF_VERIFY_CIRCUIT_N} identical failures`, () => {
  const rows = Array.from({ length: SELF_VERIFY_CIRCUIT_N - 1 }, () => ({ ...failUnit }));
  assert.equal(selfVerifyCircuitDecision(rows).open, false);
});

test("an edited spec (differing signature on top) RESETS the counter", () => {
  // Newest-first: the latest failure has a NEW signature, older ones the old one.
  const rows = [failOtherCheck, failUnit, failUnit, failUnit];
  const d = selfVerifyCircuitDecision(rows);
  assert.equal(d.count, 1, "streak only counts the new signature from the top");
  assert.equal(d.open, false);
});

test("a non-failed most-recent build (a success) RESETS the counter", () => {
  const rows = [success, failUnit, failUnit, failUnit];
  assert.equal(selfVerifyCircuitDecision(rows).open, false);
});

test("a differing failure mode (tsc) between identical self-verify fails breaks the streak", () => {
  const rows = [failUnit, failTsc, failUnit, failUnit];
  const d = selfVerifyCircuitDecision(rows);
  assert.equal(d.count, 1);
  assert.equal(d.open, false);
});
