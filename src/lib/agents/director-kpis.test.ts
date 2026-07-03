/**
 * Regression coverage for the [[director-kpis]] SDK — the folded-inclusive shipped-spec attribution
 * (director-kpi-sdk spec Phase 1). Guards the bug this SDK fixes: a merged build whose spec has
 * since folded MUST still map to its owner (`getRoadmap()` dropped it — `listSpecs()` doesn't).
 *
 * Built-in `node:test` — run: `tsx --test src/lib/agents/director-kpis.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rollupShippedSpecsByOwner } from "./director-kpis";

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
