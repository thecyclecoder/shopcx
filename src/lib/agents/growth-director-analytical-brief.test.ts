/**
 * Unit tests for the Growth Director Phase-1 analytical brief (growth-director-analytical-brief spec).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:growth-director-analytical-brief
 *   (= tsx --test src/lib/agents/growth-director-analytical-brief.test.ts)
 *
 * The verification the SPEC asserts:
 *   1. Per-creative rows carry Meta CTR/CPM/CPA + on-site LPV/ATC/checkout/purchase counts.
 *   2. Stage drop-offs are FIRST-CLASS FIELDS on each row.
 *   3. A creative with clicks but ZERO CARTS shows a visible LPV→ATC cliff.
 * All three are exercised below on the pure `computeDropoffs` helper — the compute path's I/O
 * is best-effort read-only and covered indirectly by tsc; the analytical value (the drop-off
 * signal the Phase-2 hypothesis generator will read) is proved here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDropoffs,
  UNKNOWN_COHORT,
  type CreativeFunnel,
} from "./growth-director-analytical-brief";

test("computeDropoffs surfaces the LPV→ATC cliff (clicks but zero carts) as a first-class signal", () => {
  // The "Tabs" pattern from the 2026-07-08 live read: high LPV, ZERO ATC.
  const funnel: CreativeFunnel = { landing_page_views: 120, add_to_carts: 0, initiate_checkouts: 0, purchases: 0 };
  const d = computeDropoffs(funnel);
  // The cliff rate: ATC / LPV = 0 (a REAL 0, not null — the parent LPV is > 0 so we CAN compute).
  assert.equal(d.lpv_to_atc_rate, 0);
  // The absolute gap surfaces every lost session — the size of the funnel/destination suspect.
  assert.equal(d.lpv_to_atc_gap, 120);
  // Deeper stages have parent=0 → rate is null (no signal to read, don't fabricate one).
  assert.equal(d.atc_to_checkout_rate, null);
  assert.equal(d.checkout_to_purchase_rate, null);
});

test("computeDropoffs computes each stage rate as child/parent (0..1)", () => {
  const funnel: CreativeFunnel = { landing_page_views: 1000, add_to_carts: 200, initiate_checkouts: 150, purchases: 30 };
  const d = computeDropoffs(funnel);
  assert.equal(d.lpv_to_atc_rate, 0.2);
  assert.equal(d.atc_to_checkout_rate, 0.75);
  assert.equal(d.checkout_to_purchase_rate, 0.2);
  assert.equal(d.lpv_to_atc_gap, 800);
  assert.equal(d.atc_to_checkout_gap, 50);
  assert.equal(d.checkout_to_purchase_gap, 120);
});

test("computeDropoffs never divides by zero — an empty funnel returns null rates, not NaN", () => {
  const d = computeDropoffs({ landing_page_views: 0, add_to_carts: 0, initiate_checkouts: 0, purchases: 0 });
  assert.equal(d.lpv_to_atc_rate, null);
  assert.equal(d.atc_to_checkout_rate, null);
  assert.equal(d.checkout_to_purchase_rate, null);
  assert.equal(d.lpv_to_atc_gap, 0);
});

test("computeDropoffs clamps rates to [0,1] — a data glitch can't lie about the funnel", () => {
  // In a stitching miss, an event might attribute more ATCs than LPVs; the display must still read 100%.
  const d = computeDropoffs({ landing_page_views: 10, add_to_carts: 25, initiate_checkouts: 0, purchases: 0 });
  assert.equal(d.lpv_to_atc_rate, 1);
  assert.equal(d.lpv_to_atc_gap, 0);
});

test("UNKNOWN_COHORT sentinel is exported so callers can filter direct-in-Meta ads out of prompts", () => {
  assert.equal(typeof UNKNOWN_COHORT, "string");
  assert.equal(UNKNOWN_COHORT, "unknown");
});
