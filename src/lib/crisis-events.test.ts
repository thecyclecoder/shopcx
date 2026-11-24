import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrisisRow, CRISIS_DEFAULTS } from "./crisis-events";

test("buildCrisisRow applies the dashboard defaults and starts in draft", () => {
  const row = buildCrisisRow("ws", { name: " Out of Stock: Sleep Gummies ", affected_variant_id: "42618784153773" });
  assert.equal(row.name, "Out of Stock: Sleep Gummies");
  assert.equal(row.status, "draft");
  assert.equal(row.tier2_coupon_percent, CRISIS_DEFAULTS.tier2_coupon_percent);
  assert.equal(row.lead_time_days, 7);
  assert.equal(row.tier_wait_days, 3);
  assert.deepEqual(row.available_flavor_swaps, []);
});

test("buildCrisisRow keeps explicit values, including a 0 coupon percent", () => {
  const row = buildCrisisRow("ws", { name: "x", affected_variant_id: "1", tier2_coupon_percent: 0, expected_restock_date: "2026-12-15" });
  assert.equal(row.tier2_coupon_percent, 0);
  assert.equal(row.expected_restock_date, "2026-12-15");
});

test("buildCrisisRow refuses a missing name or affected variant", () => {
  assert.throws(() => buildCrisisRow("ws", { name: "", affected_variant_id: "1" }), /name is required/);
  assert.throws(() => buildCrisisRow("ws", { name: "x", affected_variant_id: "" }), /affected_variant_id is required/);
});
