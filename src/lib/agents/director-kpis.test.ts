/**
 * Regression coverage for the [[director-kpis]] SDK — the folded-inclusive shipped-spec attribution
 * (director-kpi-sdk spec Phase 1). Guards the bug this SDK fixes: a merged build whose spec has
 * since folded MUST still map to its owner (`getRoadmap()` dropped it — `listSpecs()` doesn't).
 *
 * Built-in `node:test` — run: `tsx --test src/lib/agents/director-kpis.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  rollupAutonomyRatio,
  rollupBuildSuccessRate,
  rollupGoalsEscortedUnbabysat,
  rollupHumanTouchPerBuild,
  rollupShippedSpecsByOwner,
} from "./director-kpis";

test("shippedSpecsByOwner counts a merged build whose spec is folded (the old getRoadmap path dropped it)", () => {
  // `specSet` is what `listSpecs(ws)` returns — every spec incl. status='folded'. The old
  // `getRoadmap()` path filtered to boardable specs (non-folded), so the folded spec would have
  // been ABSENT from its slug→owner map and the merged build would drop off the count.
  const specSet = [
    { slug: "spec-live", owner: "platform" },
    { slug: "spec-folded-today", owner: "platform" }, // folded — still in listSpecs, dropped from getRoadmap
    { slug: "spec-growth-live", owner: "growth" },
  ];
  const mergedSlugs = [
    "spec-live",
    "spec-folded-today",
    "spec-growth-live",
    "spec-orphan", // no matching spec row — dropped (no owner to attribute to)
    null, // spec_slug is nullable on agent_jobs — dropped
  ];

  const all = rollupShippedSpecsByOwner(specSet, mergedSlugs);
  assert.equal(all.countsByOwner.platform, 2, "folded spec must still count under platform");
  assert.equal(all.countsByOwner.growth, 1);
  assert.deepEqual(
    [...all.slugsByOwner.platform].sort(),
    ["spec-folded-today", "spec-live"],
    "folded slug must appear in the platform slug list",
  );

  const platformOnly = rollupShippedSpecsByOwner(specSet, mergedSlugs, "platform");
  assert.equal(platformOnly.countsByOwner.platform, 2);
  assert.equal(platformOnly.countsByOwner.growth, undefined, "owner filter must exclude other owners");
});

test("rollup returns empty maps when there are no merged builds", () => {
  const r = rollupShippedSpecsByOwner(
    [{ slug: "spec-live", owner: "platform" }],
    [],
  );
  assert.deepEqual(r.countsByOwner, {});
  assert.deepEqual(r.slugsByOwner, {});
});

test("rollup ignores specs whose owner is null (no attribution target)", () => {
  const r = rollupShippedSpecsByOwner(
    [
      { slug: "spec-orphan-owner", owner: null },
      { slug: "spec-real", owner: "platform" },
    ],
    ["spec-orphan-owner", "spec-real"],
  );
  assert.equal(r.countsByOwner.platform, 1);
  assert.equal(Object.keys(r.countsByOwner).length, 1);
});

// ── Phase 2 — parity coverage for the 4 SDK functions ─────────────────────────────────────────

test("rollupBuildSuccessRate: rate = merged / (merged + failed), 0 when total is 0", () => {
  assert.deepEqual(rollupBuildSuccessRate(3, 1), { rate: 0.75, merged: 3, failed: 1, total: 4 });
  assert.deepEqual(rollupBuildSuccessRate(0, 0), { rate: 0, merged: 0, failed: 0, total: 0 });
  assert.deepEqual(rollupBuildSuccessRate(0, 2), { rate: 0, merged: 0, failed: 2, total: 2 });
  assert.deepEqual(rollupBuildSuccessRate(5, 0), { rate: 1, merged: 5, failed: 0, total: 5 });
});

test("rollupAutonomyRatio: autonomous / terminal, escalated rows never make it in", () => {
  // The SDK's caller filters to `decision ∈ approved｜declined` before rollup; the rollup itself
  // trusts the input. Seed a mix of autonomous/non-autonomous approvals + declines.
  const rows = [
    { decision: "approved", autonomous: true },
    { decision: "approved", autonomous: true },
    { decision: "approved", autonomous: false }, // CEO touch — counted terminal, not autonomous
    { decision: "declined", autonomous: true },
    { decision: "declined", autonomous: false },
  ];
  assert.deepEqual(rollupAutonomyRatio(rows), {
    ratio: 3 / 5, autonomous: 3, terminal: 5, approved: 3, declined: 2,
  });
  assert.deepEqual(rollupAutonomyRatio([]), { ratio: 0, autonomous: 0, terminal: 0, approved: 0, declined: 0 });
});

test("rollupHumanTouchPerBuild: touched / builds, 0 when builds is 0", () => {
  assert.deepEqual(rollupHumanTouchPerBuild(4, 20), { ratio: 0.2, touched: 4, builds: 20 });
  assert.deepEqual(rollupHumanTouchPerBuild(0, 20), { ratio: 0, touched: 0, builds: 20 });
  assert.deepEqual(rollupHumanTouchPerBuild(4, 0), { ratio: 0, touched: 4, builds: 0 });
});

test("rollupGoalsEscortedUnbabysat: drops any goal whose milestone spec was CEO-touched", () => {
  // Two escorted goals with shipped milestones. `goal-clean` has zero touches on its specs; the
  // other has ONE — a single touched spec is enough to babysit the whole goal.
  const candidates = [
    { slug: "goal-clean", milestones: ["M2"], specSlugs: new Set(["spec-a", "spec-b"]) },
    { slug: "goal-touched", milestones: ["M3", "M4"], specSlugs: new Set(["spec-c", "spec-d"]) },
    { slug: "goal-clean-2", milestones: ["M1"], specSlugs: new Set(["spec-e"]) },
  ];
  const touched = new Set(["spec-c"]); // babysits goal-touched (via spec-c ∈ M3 or M4)
  const r = rollupGoalsEscortedUnbabysat(candidates, touched);
  assert.equal(r.count, 2, "only clean goals count as escorted-unbabysat");
  assert.deepEqual(
    r.goals.map((g) => g.goal).sort(),
    ["goal-clean", "goal-clean-2"],
  );
  const clean = r.goals.find((g) => g.goal === "goal-clean");
  assert.deepEqual(clean?.milestones, ["M2"], "milestone list preserved for the clean goal");
});

test("rollupGoalsEscortedUnbabysat: empty inputs return count:0", () => {
  assert.deepEqual(rollupGoalsEscortedUnbabysat([], new Set()), { count: 0, goals: [] });
});
