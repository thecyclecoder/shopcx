/**
 * Pins the two pure rules behind the 2026-08-25 media-buyer hotfix.
 *
 * 1. `crownUpperBoundCpaCents` — crown on the PESSIMISTIC end of the CPA estimate.
 *    The wedge: all 5 crowned winners were crowned on the POINT estimate at 7–13 purchases, sitting
 *    just under the $240 line ($214 / $222 / $228). Pooled post-crown CPA came in at 1.89x pre-crown
 *    while scaled IN PLACE — regression to the mean, not a scale-campaign artifact.
 *
 * 2. `isTestRailObject` — two independent sources for the test rail. The wedge: 7 scale_ups landed
 *    on Bianca's test adsets Aug 18–24 (skeptic-bloat $259 -> $1,337/day) even though those adsets
 *    resolve inside the exclusion set today. A rail sourced from ONE synced table can go blind.
 *
 * Run: npx tsx --test src/lib/media-buyer/crown-and-rail.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crownUpperBoundCpaCents, CROWN_CONFIDENCE_Z, insightCountsTowardSignal } from "./meta-cpa-signal";
import { isTestRailObject } from "@/lib/meta/decision-engine";

// ── crownUpperBoundCpaCents ────────────────────────────────────────────────

test("the bound always sits ABOVE the measured CPA — it is a penalty, never a discount", () => {
  for (const n of [1, 5, 8, 15, 25, 100]) {
    assert.ok(crownUpperBoundCpaCents(22000, n) > 22000, `n=${n} must widen upward`);
  }
});

test("the penalty SHRINKS as the sample grows — more purchases, more trust", () => {
  const at8 = crownUpperBoundCpaCents(22000, 8);
  const at15 = crownUpperBoundCpaCents(22000, 15);
  const at40 = crownUpperBoundCpaCents(22000, 40);
  assert.ok(at8 > at15 && at15 > at40, "bound must tighten monotonically with n");
});

test("the exact adsets we crowned in August no longer qualify at the old 8-purchase sample", () => {
  // 120250419137310326 was crowned at $222 CPA on 8 purchases, just under the $240 line.
  const bound = crownUpperBoundCpaCents(22200, 8);
  assert.ok(bound > 24000, `an 8-purchase $222 CPA must NOT clear a $240 crown (bound $${(bound / 100).toFixed(0)})`);
});

test("a genuinely strong adset still crowns — the rule is not a blanket ban", () => {
  // $99 CPA on 8 purchases (adset 120249488919900682's pre-crown number) is far enough under
  // the line that even the pessimistic end clears it.
  assert.ok(crownUpperBoundCpaCents(9900, 8) <= 24000, "a $99 CPA at n=8 should still crown");
});

test("raising the sample lets a borderline adset crown once it has actually earned it", () => {
  // $180 straddles the rule: too noisy to trust on 8 purchases, credible on 25.
  assert.ok(crownUpperBoundCpaCents(18000, 8) > 24000, "$180 CPA at n=8 is still too noisy");
  assert.ok(crownUpperBoundCpaCents(18000, 25) <= 24000, "$180 CPA at n=25 has earned the crown");
});

test("calibration — where the rule actually bites against a $240 crown", () => {
  // Recorded so a future tuner can see the shape rather than re-deriving it.
  // At n=8 the break-even measured CPA is 240 / exp(1.28/sqrt(8)) ~= $153.
  assert.ok(crownUpperBoundCpaCents(15000, 8) <= 24000, "$150 at n=8 still clears");
  assert.ok(crownUpperBoundCpaCents(16000, 8) > 24000, "$160 at n=8 does not");
});

test("zero / negative / non-finite inputs are never crownable", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(crownUpperBoundCpaCents(bad, 10), Number.POSITIVE_INFINITY);
    assert.equal(crownUpperBoundCpaCents(22000, bad), Number.POSITIVE_INFINITY);
  }
});

test("z=0 reproduces the OLD point-estimate rule exactly (the documented escape hatch)", () => {
  assert.equal(crownUpperBoundCpaCents(22000, 8, 0), 22000);
});

test("the default z is the business-grade 90% one-sided, not research-grade 95%", () => {
  assert.equal(CROWN_CONFIDENCE_Z, 1.28);
});

// ── isTestRailObject ───────────────────────────────────────────────────────

const EXCLUDED = new Set(["120250143054030326"]);
const TEST_CAMPAIGNS = new Set(["120250066504550326"]);

test("an adset in the exclusion set is refused", () => {
  assert.equal(isTestRailObject({ object_id: "120250143054030326" }, EXCLUDED, TEST_CAMPAIGNS), true);
});

test("⭐ an adset MISSING from the roster is still refused via its parent campaign", () => {
  // This is the whole point: meta_adsets went stale / never synced this adset, so the id is not in
  // EXCLUDED — but its parent IS a test campaign, so the rail still holds.
  assert.equal(
    isTestRailObject(
      { object_id: "999-never-synced", parent_campaign_id: "120250066504550326" },
      EXCLUDED,
      TEST_CAMPAIGNS,
    ),
    true,
  );
});

test("a scaling-campaign adset is ALLOWED — the cold scaler is the legitimate scaling target", () => {
  assert.equal(
    isTestRailObject(
      { object_id: "cold-scaler-adset", parent_campaign_id: "120250620926360326" },
      EXCLUDED,
      TEST_CAMPAIGNS,
    ),
    false,
  );
});

test("a null parent campaign falls back to the roster check without throwing", () => {
  assert.equal(isTestRailObject({ object_id: "unrelated", parent_campaign_id: null }, EXCLUDED, TEST_CAMPAIGNS), false);
  assert.equal(isTestRailObject({ object_id: "120250143054030326", parent_campaign_id: null }, EXCLUDED, TEST_CAMPAIGNS), true);
});

test("an EMPTY campaign set degrades to roster-only — it must not accidentally allow everything", () => {
  assert.equal(isTestRailObject({ object_id: "120250143054030326" }, EXCLUDED, new Set()), true);
});

// ── insightCountsTowardSignal — contaminated history must not reach a crown ──
//
// The wedge: three test adsets (47-49d old) predated the existing-customer exclusion feature, so
// existing customers could convert inside a "cold" test — inflating purchases and flattering CPA.
// `crownUpperBoundCpaCents` guards a SMALL sample; it does nothing about a DIRTY one. Repairing the
// targeting only cleans the signal going forward, while the crown reads LIFETIME totals — so a
// repaired adset would still be judged on 10 contaminated purchases plus N clean ones.

test("no floor ⇒ every day counts — the default for every adset never repaired", () => {
  assert.equal(insightCountsTowardSignal("2026-07-01", null), true);
  assert.equal(insightCountsTowardSignal("2026-07-01", undefined), true);
});

test("⭐ days BEFORE the repair are discarded — the contaminated purchases can't crown it", () => {
  assert.equal(insightCountsTowardSignal("2026-07-14", "2026-08-25T14:00:00.000Z"), false);
  assert.equal(insightCountsTowardSignal("2026-08-24", "2026-08-25T14:00:00.000Z"), false);
});

test("the cutover DAY itself is discarded — it is partly pre-repair", () => {
  // Counting it would re-admit exactly the contamination the floor exists to exclude.
  assert.equal(insightCountsTowardSignal("2026-08-25", "2026-08-25T14:00:00.000Z"), false);
});

test("days strictly AFTER the repair count", () => {
  assert.equal(insightCountsTowardSignal("2026-08-26", "2026-08-25T14:00:00.000Z"), true);
  assert.equal(insightCountsTowardSignal("2026-09-10", "2026-08-25T14:00:00.000Z"), true);
});

test("a date-only floor works the same as a full timestamp", () => {
  assert.equal(insightCountsTowardSignal("2026-08-25", "2026-08-25"), false);
  assert.equal(insightCountsTowardSignal("2026-08-26", "2026-08-25"), true);
});

test("comparison is lexicographic on ISO days, so month/year boundaries are not special-cased wrong", () => {
  assert.equal(insightCountsTowardSignal("2026-09-01", "2026-08-31"), true);
  assert.equal(insightCountsTowardSignal("2026-08-31", "2026-09-01"), false);
  assert.equal(insightCountsTowardSignal("2027-01-01", "2026-12-31"), true);
});
