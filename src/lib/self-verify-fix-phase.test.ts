/**
 * autobuild-circuit-break-on-repeated-pre-commit-self-verify-failure Phase 2 — the decompose-vs-noop
 * decision behind the build lane's "escaped to fix-phase self-heal" branch. The named failing state: the
 * branch logged "escaped to fix-phase self-heal" yet materialized NO fix phases, so the next build restarted
 * and failed identically (close-snapshot-coverage-guard, whose only failing check was the whole-registered
 * `unit_test` suite — not decomposable into a per-anchor fix phase).
 *
 * Run: npx tsx --test src/lib/self-verify-fix-phase.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideSelfVerifySelfHeal,
  isDecomposableSelfVerifyCheck,
  SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX,
  type ExistingFixPhaseRow,
} from "@/lib/self-verify-fix-phase";

const unitSuite = { text: "the registered test suite passes", exec_kind: "unit_test", evidence: "1 failing" };
const buildCheck = { text: "next build succeeds", exec_kind: "build", evidence: "" };
const tscCheck = { text: "repo typechecks clean", exec_kind: "tsc", evidence: "" };
const grepCheck = { text: "export setSpecHumanReview exists in specs-table.ts", exec_kind: "grep", evidence: "no match" };
const grepCheck2 = { text: "column foo exists on bar", exec_kind: "grep", evidence: "no match" };

test("decomposability: grep is per-anchor; unit_test/build/tsc/null are whole-artifact", () => {
  assert.equal(isDecomposableSelfVerifyCheck("grep"), true);
  assert.equal(isDecomposableSelfVerifyCheck("unit_test"), false);
  assert.equal(isDecomposableSelfVerifyCheck("build"), false);
  assert.equal(isDecomposableSelfVerifyCheck("tsc"), false);
  assert.equal(isDecomposableSelfVerifyCheck(null), false);
});

test("the close-snapshot case (whole-suite unit_test only) → self_heal_noop(all_whole_artifact)", () => {
  const d = decideSelfVerifySelfHeal({ failing: [unitSuite], existingFixPhases: [] });
  assert.equal(d.action, "noop");
  if (d.action === "noop") {
    assert.equal(d.reason, "all_whole_artifact");
    assert.match(d.detail, /unit_test/);
  }
});

test("a per-anchor grep failure → append ONE fix phase per anchor with a locally-checkable verification", () => {
  const d = decideSelfVerifySelfHeal({ failing: [grepCheck, grepCheck2], existingFixPhases: [] });
  assert.equal(d.action, "append");
  if (d.action === "append") {
    assert.equal(d.fixes.length, 2);
    for (const f of d.fixes) {
      assert.ok(f.verification.includes("(grep)"), "verification names the grep check so it is locally re-checkable");
      assert.equal(f.origin_check_keys.length, 1);
    }
    assert.ok(d.signature.includes(","), "signature is the sorted union of both anchor keys");
  }
});

test("mixed: a grep anchor alongside a whole-suite check still appends the decomposable one", () => {
  const d = decideSelfVerifySelfHeal({ failing: [unitSuite, grepCheck], existingFixPhases: [] });
  assert.equal(d.action, "append");
  if (d.action === "append") assert.equal(d.fixes.length, 1);
});

test("dedup: a pending unbuilt fix phase covering the same anchors → self_heal_noop(already_pending)", () => {
  const key = "grep:export setspechumanreview exists in specs-table.ts";
  const existing: ExistingFixPhaseRow[] = [{ status: "planned", build_sha: null, origin_check_keys: [key] }];
  const d = decideSelfVerifySelfHeal({ failing: [grepCheck], existingFixPhases: existing });
  assert.equal(d.action, "noop");
  if (d.action === "noop") assert.equal(d.reason, "already_pending");
});

test("a SHIPPED fix phase with the same keys does NOT dedup — a fresh anchor gap re-appends", () => {
  const key = "grep:export setspechumanreview exists in specs-table.ts";
  const existing: ExistingFixPhaseRow[] = [{ status: "shipped", build_sha: "abc123", origin_check_keys: [key] }];
  const d = decideSelfVerifySelfHeal({ failing: [grepCheck], existingFixPhases: existing });
  assert.equal(d.action, "append");
});

test("loop-guard: at the fix-cycle cap, stop appending → self_heal_noop(loop_guard)", () => {
  const existing: ExistingFixPhaseRow[] = Array.from({ length: SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX }, (_v, i) => ({
    status: "planned",
    build_sha: null,
    origin_check_keys: [`grep:old-anchor-${i}`],
  }));
  const d = decideSelfVerifySelfHeal({ failing: [grepCheck], existingFixPhases: existing });
  assert.equal(d.action, "noop");
  if (d.action === "noop") assert.equal(d.reason, "loop_guard");
});

test("no failing checks → self_heal_noop(no_failing)", () => {
  const d = decideSelfVerifySelfHeal({ failing: [], existingFixPhases: [] });
  assert.equal(d.action, "noop");
  if (d.action === "noop") assert.equal(d.reason, "no_failing");
});

test("build + tsc whole-artifact pair (no grep) → self_heal_noop(all_whole_artifact)", () => {
  const d = decideSelfVerifySelfHeal({ failing: [buildCheck, tscCheck], existingFixPhases: [] });
  assert.equal(d.action, "noop");
  if (d.action === "noop") assert.equal(d.reason, "all_whole_artifact");
});
