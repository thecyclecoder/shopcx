import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateCrisisSubstitution, type SubstitutionCrisis } from "./crisis-substitution";

// Crisis 99a58332: Cocoa instant coffee out of stock, Amplifier ships Hazelnut instead.
const cocoaCrisis: SubstitutionCrisis = {
  id: "99a58332",
  affected_variant_id: "cocoa-variant",
  affected_sku: "SC-COFFEE-COCOA",
  default_swap_title: "Hazelnut",
  status: "active",
  created_at: "2026-11-05T00:00:00Z",
  resolved_at: null,
};

test("a Cocoa line shipped after the crisis started is flagged with likely flavor Hazelnut", () => {
  const [line] = annotateCrisisSubstitution(
    [{ variant_id: "cocoa-variant", sku: "SC-COFFEE-COCOA" }],
    { amplifier_shipped_at: "2026-11-10T00:00:00Z" },
    [cocoaCrisis],
  );
  assert.equal(line.likely_substituted, true);
  assert.equal(line.likely_shipped_flavor, "Hazelnut");
  assert.equal(line.crisis_id, "99a58332");
});

test("a line shipped BEFORE the crisis started is not flagged", () => {
  const [line] = annotateCrisisSubstitution(
    [{ variant_id: "cocoa-variant", sku: "SC-COFFEE-COCOA" }],
    { amplifier_shipped_at: "2026-11-01T00:00:00Z" },
    [cocoaCrisis],
  );
  assert.equal(line.likely_substituted, false);
  assert.equal(line.likely_shipped_flavor, undefined);
});

test("a line whose variant is not under any crisis is not flagged", () => {
  const [line] = annotateCrisisSubstitution(
    [{ variant_id: "vanilla-variant", sku: "SC-COFFEE-VANILLA" }],
    { amplifier_shipped_at: "2026-11-10T00:00:00Z" },
    [cocoaCrisis],
  );
  assert.equal(line.likely_substituted, false);
});

test("an order with no Amplifier ship stamp is never flagged (warehouse hasn't shipped)", () => {
  const [line] = annotateCrisisSubstitution(
    [{ variant_id: "cocoa-variant", sku: "SC-COFFEE-COCOA" }],
    { amplifier_shipped_at: null },
    [cocoaCrisis],
  );
  assert.equal(line.likely_substituted, false);
});

test("a resolved crisis still flags a ship that happened before it resolved", () => {
  const resolved: SubstitutionCrisis = {
    ...cocoaCrisis,
    status: "resolved",
    resolved_at: "2026-11-15T00:00:00Z",
  };
  const [shippedDuring] = annotateCrisisSubstitution(
    [{ variant_id: "cocoa-variant" }],
    { amplifier_shipped_at: "2026-11-10T00:00:00Z" },
    [resolved],
  );
  assert.equal(shippedDuring.likely_substituted, true);

  // Shipped AFTER the crisis resolved → the flavor was back in stock, not flagged.
  const [shippedAfter] = annotateCrisisSubstitution(
    [{ variant_id: "cocoa-variant" }],
    { amplifier_shipped_at: "2026-11-20T00:00:00Z" },
    [resolved],
  );
  assert.equal(shippedAfter.likely_substituted, false);
});
