/**
 * Unit tests for the subscriber lifecycle-experiment harness pure core (subscriber-experiment-harness).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/subscriber-experiments.test.ts
 *
 * The DB-dependent paths (assignArm/getArm/createExperiment) are integration-tested against a real
 * pooler via the spec's Verification checklist + the SDK-compliance guard. The tests below pin the
 * PURE invariants the correctness of the whole harness rests on:
 *   1. hashToUnit is deterministic + in [0,1) — stickiness without persisting.
 *   2. bucketArm is STICKY: the same (groupId, experimentId) always lands on the same arm.
 *   3. The holdout band is a TRUE holdout at the configured split: holdoutPct=0 → never holdout,
 *      holdoutPct=100 → always holdout, and a 50/50 split is ~half across many groups.
 *   4. powerCalcRequiredN grows as MDE shrinks / power rises, and rejects a non-positive MDE/CV.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hashToUnit, bucketArm, powerCalcRequiredN } from "@/lib/subscriber-experiments";

test("hashToUnit is deterministic and in [0,1)", () => {
  const a = hashToUnit("group-A:exp-1");
  const b = hashToUnit("group-A:exp-1");
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
  assert.notEqual(hashToUnit("group-A:exp-1"), hashToUnit("group-B:exp-1"));
});

test("bucketArm is sticky for the same (groupId, experimentId)", () => {
  const first = bucketArm("exp-1", "group-A", 50);
  for (let i = 0; i < 100; i++) {
    assert.equal(bucketArm("exp-1", "group-A", 50), first);
  }
});

test("holdoutPct=0 is never holdout; holdoutPct=100 is always holdout", () => {
  for (let i = 0; i < 200; i++) {
    const g = `group-${i}`;
    assert.equal(bucketArm("exp-1", g, 0), "treatment");
    assert.equal(bucketArm("exp-1", g, 100), "holdout");
  }
});

test("a 50/50 split bands roughly half the groups to holdout", () => {
  let holdout = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (bucketArm("exp-50", `group-${i}`, 50) === "holdout") holdout++;
  }
  const share = holdout / N;
  // deterministic hash over 2000 distinct keys — expect close to 0.5.
  assert.ok(share > 0.45 && share < 0.55, `holdout share ${share} not ~0.5`);
});

test("powerCalcRequiredN grows as MDE shrinks and as power rises", () => {
  const base = powerCalcRequiredN({ mde: 0.1, power: 0.8, alpha: 0.05, baselineCv: 1 });
  const smallerMde = powerCalcRequiredN({ mde: 0.05, power: 0.8, alpha: 0.05, baselineCv: 1 });
  const higherPower = powerCalcRequiredN({ mde: 0.1, power: 0.9, alpha: 0.05, baselineCv: 1 });
  assert.ok(smallerMde > base, "halving MDE must raise required N");
  assert.ok(higherPower > base, "raising power must raise required N");
  assert.equal(base, Math.ceil(base), "N is an integer");
});

test("powerCalcRequiredN rejects a non-positive MDE or CV", () => {
  assert.throws(() => powerCalcRequiredN({ mde: 0, power: 0.8, alpha: 0.05, baselineCv: 1 }));
  assert.throws(() => powerCalcRequiredN({ mde: 0.1, power: 0.8, alpha: 0.05, baselineCv: 0 }));
});
