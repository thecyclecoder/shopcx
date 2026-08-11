/**
 * The dep-upgrade loop must survive its own canonical spec folding.
 *
 * The bug (measured 2026-08-11): the dep-watch lane authors every advisory batch into the FIXED slug
 * `security-dep-upgrades`. `authorSpecRowStructured` will not resurrect an archived spec —
 * `reopenIfReauthoredAndChanged` returns early on `status === 'folded'`, deliberately, so a fold
 * stays final. So the moment a dep-upgrade batch ships and folds, every later batch is authored into
 * an archived row that never re-enters the build pipeline.
 *
 * `security-dep-upgrades` folded on 2026-08-03. Eight days later there were **11 actionable
 * advisories (8 high) with fixes available**, and the only surface was a park card reading
 * "7 advisory(ies) but spec author failed". The loop had been dead the whole time.
 *
 *   npx tsx --test src/lib/security-agent.dep-upgrade-cycle.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { depUpgradeCycleSlug, SECURITY_DEP_UPGRADE_SLUG } from "./security-agent";

test("the cycle slug is derived from the canonical one, so it stays greppable", () => {
  const slug = depUpgradeCycleSlug(new Date("2026-08-11T12:00:00Z"));
  assert.ok(slug.startsWith(SECURITY_DEP_UPGRADE_SLUG), "cycle slug must extend the canonical slug");
  assert.equal(slug, "security-dep-upgrades-2026-08");
});

test("the slug is STABLE within a month — a re-run refreshes one spec, it does not proliferate", () => {
  const early = depUpgradeCycleSlug(new Date("2026-08-01T00:00:00Z"));
  const late = depUpgradeCycleSlug(new Date("2026-08-31T23:59:59Z"));
  assert.equal(early, late);
});

test("the slug ROLLS at the month boundary — a folded cycle can never block the next one", () => {
  const aug = depUpgradeCycleSlug(new Date("2026-08-31T23:59:59Z"));
  const sep = depUpgradeCycleSlug(new Date("2026-09-01T00:00:00Z"));
  assert.notEqual(aug, sep);
  assert.equal(sep, "security-dep-upgrades-2026-09");
});

test("month is zero-padded and computed in UTC (the box's clock is not local)", () => {
  assert.equal(depUpgradeCycleSlug(new Date("2026-01-05T00:00:00Z")), "security-dep-upgrades-2026-01");
  // A UTC-January instant that is still December locally must resolve by UTC.
  assert.equal(depUpgradeCycleSlug(new Date("2027-01-01T00:30:00Z")), "security-dep-upgrades-2027-01");
});

test("the lane consults the fold status before authoring", async () => {
  // Static-analysis: the worker's authorDepUpgradeSpec must roll to the cycle slug on a folded
  // canonical spec. Importing builder-worker.ts would boot the worker.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../scripts/builder-worker.ts", import.meta.url), "utf8"),
  );
  const fn = src.slice(src.indexOf("async function authorDepUpgradeSpec"));
  const body = fn.slice(0, 3000);
  assert.match(body, /status === "folded"/, "must branch on the canonical spec being folded");
  assert.match(body, /depUpgradeCycleSlug\(\)/, "must roll to the cycle slug");
});
