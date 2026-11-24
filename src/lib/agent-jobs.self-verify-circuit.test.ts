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
  deriveTscFailSignature,
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
const failTscBase = { status: "failed", error: "tsc failed" };
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

// ─── mario-fix-tsc-oom-and-circuit-breaker-gap Phase 2 ──────────────────────────────────────────────
// A deterministic tsc-after-repair failure (fixed `error` string; compiler output lives in `log_tail`)
// had NO self-verify signature, so selfVerifyCircuitDecision bailed at its null-signature guard and
// never counted it — enqueueBuildIfDue re-queued the identical failing build forever
// (ai-shopping-agent-mcp, build 2026-11-23T22:56:58). These assert the tsc-fail namespace counts toward
// its OWN streak and never mixes with the self-verify-unresolved namespace.

test("deriveTscFailSignature namespaces tsc failures and is null for non-tsc errors", () => {
  assert.ok(deriveTscFailSignature(failTsc.error)?.startsWith("tsc-fail:"), "tsc-after-repair → tsc-fail: signature");
  assert.ok(deriveTscFailSignature(failTscBase.error)?.startsWith("tsc-fail:"), "bare tsc fail → tsc-fail: signature");
  assert.equal(deriveTscFailSignature(failUnit.error), null, "a self-verify-unresolved error is not a tsc failure");
  assert.equal(deriveTscFailSignature(null), null);
  // Identical tsc errors share a signature; distinct tsc gate points do NOT (conservative — never merge
  // two different failure modes into one streak).
  assert.equal(deriveTscFailSignature(failTsc.error), deriveTscFailSignature("tsc failed after pre-commit self-verify repair"));
  assert.notEqual(deriveTscFailSignature(failTsc.error), deriveTscFailSignature(failTscBase.error));
});

test(`circuit OPENS at ${SELF_VERIFY_CIRCUIT_N} consecutive identical tsc-after-repair failures (the ai-shopping-agent-mcp loop)`, () => {
  const rows = Array.from({ length: SELF_VERIFY_CIRCUIT_N }, () => ({ ...failTsc }));
  const d = selfVerifyCircuitDecision(rows);
  assert.equal(d.open, true);
  assert.equal(d.count, SELF_VERIFY_CIRCUIT_N);
  assert.ok(d.signature?.startsWith("tsc-fail:"), "breaker reports the tsc-fail signature, not a self-verify one");
});

test("tsc-fail and self-verify-unresolved namespaces NEVER share a streak", () => {
  // A self-verify fail on top of identical tsc fails counts only the top row — the namespaces differ.
  const svOnTsc = selfVerifyCircuitDecision([failUnit, failTsc, failTsc, failTsc]);
  assert.equal(svOnTsc.count, 1);
  assert.equal(svOnTsc.open, false);
  // And two DIFFERENT tsc gate points (bare vs after-repair) break each other's streak.
  const mixedTsc = selfVerifyCircuitDecision([failTsc, failTscBase, failTsc, failTsc]);
  assert.equal(mixedTsc.count, 1);
  assert.equal(mixedTsc.open, false);
});
