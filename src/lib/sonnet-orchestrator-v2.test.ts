/**
 * Unit tests for the Phase-2 adoption WARN counter on Sonnet's
 * decision-record fields (ticket-resolution-events-writeahead-ledger-
 * and-decision-schema-extension). Pure helper — no network, no DB. Run:
 *   npm run test:sonnet-orchestrator
 *   (= tsx --test src/lib/sonnet-orchestrator-v2.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  warnOnMissingResolutionFields,
  resolutionSchemaAdoption,
  computeChargedLineTotals,
  resolveLineVariantTitle,
  type SonnetDecision,
} from "./sonnet-orchestrator-v2";

function resetCounters(): void {
  resolutionSchemaAdoption.total = 0;
  resolutionSchemaAdoption.missingProblem = 0;
  resolutionSchemaAdoption.missingConfidence = 0;
  resolutionSchemaAdoption.missingOptions = 0;
  resolutionSchemaAdoption.missingChosen = 0;
}

// ── Named failing state ────────────────────────────────────────────────
// Spec Phase-2 verification bullet #2: "On a Sonnet run where the model
// omits the new fields (backward-compat check) → expect the decision
// still executes AND a WARN counter increments in structured logs".
// The smallest test for that exact state: a real, parsed decision with
// none of the new fields → every miss flagged, total counter +1, and
// the decision itself is not mutated (still executable).
test("real decision missing every new field → 4 misses, adoption total +=1, decision still executes", () => {
  resetCounters();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "ai_response",
      response_message: "hi",
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(
      missing.sort(),
      ["chosen", "confidence", "options", "problem"],
      "every new field should be flagged missing",
    );
    assert.equal(resolutionSchemaAdoption.total, 1, "adoption counter should tick once per missed decision");
    assert.equal(resolutionSchemaAdoption.missingProblem, 1);
    assert.equal(resolutionSchemaAdoption.missingConfidence, 1);
    assert.equal(resolutionSchemaAdoption.missingOptions, 1);
    assert.equal(resolutionSchemaAdoption.missingChosen, 1);
    assert.equal(warnings.length, 1, "one structured WARN emitted");
    assert.ok(
      warnings[0].includes("[resolution-schema-adoption]"),
      `WARN should carry the aggregation prefix, got: ${warnings[0]}`,
    );
    // Backward-compat: decision itself is unchanged; the executor still
    // ships response_message as usual.
    assert.equal(decision.action_type, "ai_response");
    assert.equal(decision.response_message, "hi");
  } finally {
    console.warn = originalWarn;
  }
});

// A fully-populated decision must NOT tick any counter — the WARN is
// specifically the "adoption gap" signal, not a per-decision heartbeat.
test("real decision with all four new fields → no misses, no WARN, no counter tick", () => {
  resetCounters();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "direct_action",
      problem: "customer wants to pause",
      confidence: 0.9,
      options: [
        { label: "pause 30d", expected_effect: "next order pushed 30d" },
      ],
      chosen: { option_index: 0, why: "matches ask" },
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(missing, []);
    assert.equal(resolutionSchemaAdoption.total, 0);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

// Partial adoption is the realistic path during rollout — the counter
// still ticks (there IS a gap) but only the specific missed fields flag.
test("partial adoption (problem + confidence only) → 2 misses tallied on the specific counters", () => {
  resetCounters();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "ai_response",
      problem: "shipping question",
      confidence: 0.7,
      // options + chosen deliberately absent
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(missing.sort(), ["chosen", "options"]);
    assert.equal(resolutionSchemaAdoption.missingProblem, 0);
    assert.equal(resolutionSchemaAdoption.missingConfidence, 0);
    assert.equal(resolutionSchemaAdoption.missingOptions, 1);
    assert.equal(resolutionSchemaAdoption.missingChosen, 1);
    assert.equal(resolutionSchemaAdoption.total, 1);
  } finally {
    console.warn = originalWarn;
  }
});

// NaN confidence is a real-model artifact when the model emits invalid
// JSON that JSON.parse coerces to NaN. Must count as missing (would
// otherwise poison the ticket_resolution_events.confidence CHECK gate).
test("NaN / non-finite confidence counts as missing", () => {
  resetCounters();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "ai_response",
      problem: "x",
      confidence: Number.NaN,
      options: [],
      chosen: { option_index: 0, why: "x" },
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(missing, ["confidence"]);
    assert.equal(resolutionSchemaAdoption.missingConfidence, 1);
  } finally {
    console.warn = originalWarn;
  }
});

// ── Named failing state (Phase 1 of docs/brain/specs/orchestrator-surfaces
// -line-item-variant-and-computed-per-unit-price.md) ────────────────────
// Ticket cd2e4a9a: order carries 2 units and total $44.74, but the pre-fix
// orchestrator surfaced $22.46/unit (Shopify originalUnitPriceSet, pre-
// discount) and the AI proceeded to invent multiplication from there. The
// asserted correct state: surface per-unit = $22.37, i.e. line total ÷
// quantity from the real amounts the order carries — never $22.46.
test("Phase 1 — ticket cd2e4a9a: 2-unit / $44.74 line surfaces $22.37/unit, not $22.46", () => {
  const order = { total_cents: 4474 };
  const lines = [{ quantity: 2, price_cents: 2246 }]; // MSRP-ish per-unit
  const [row] = computeChargedLineTotals(order, lines);
  assert.equal(row.perUnitCents, 2237, "per-unit must be line total ÷ qty ($22.37), not the MSRP-ish $22.46");
  assert.equal(row.chargedTotalCents, 4474, "line total for a single-line order is the whole order charged");
});

test("Phase 1 — payment_details.subtotal_cents wins over order.total_cents (shipping/tax excluded)", () => {
  const order = { total_cents: 5000, payment_details: { subtotal_cents: 4474 } };
  const lines = [{ quantity: 2, price_cents: 2246 }];
  const [row] = computeChargedLineTotals(order, lines);
  assert.equal(row.chargedTotalCents, 4474);
  assert.equal(row.perUnitCents, 2237);
});

test("Phase 1 — line_total_cents on the row overrides pro-rata", () => {
  const order = { total_cents: 9999 };
  const lines = [{ quantity: 2, price_cents: 2246, line_total_cents: 4474 }];
  const [row] = computeChargedLineTotals(order, lines);
  assert.equal(row.chargedTotalCents, 4474);
  assert.equal(row.perUnitCents, 2237);
});

test("Phase 1 — multi-line order distributes charged total by (price_cents × qty) weight", () => {
  // Two lines: A = $22.46 × 2 = $44.92, B = $30.00 × 1 = $30.00, weights 44.92:30
  // Charged subtotal = $70 (some order-level discount reduced $74.92 → $70).
  // Line A gets 44.92/74.92 × 7000 = 4196c; line B gets 2804c.
  const order = { total_cents: 7000 };
  const lines = [
    { quantity: 2, price_cents: 2246 },
    { quantity: 1, price_cents: 3000 },
  ];
  const [a, b] = computeChargedLineTotals(order, lines);
  assert.equal(a.chargedTotalCents + b.chargedTotalCents <= 7000 + 1 && a.chargedTotalCents + b.chargedTotalCents >= 7000 - 1, true, "sum must round to the order charged total ±1");
  assert.equal(a.perUnitCents, Math.round(a.chargedTotalCents / 2));
  assert.equal(b.perUnitCents, b.chargedTotalCents);
  assert.ok(a.perUnitCents < 2246 && a.perUnitCents > 2000, `line A per-unit ${a.perUnitCents} should reflect the order-level discount`);
});

test("Phase 1 — fallback to price_cents × qty when no order-side charged total is known", () => {
  const order = {}; // no total, no payment_details
  const lines = [{ quantity: 3, price_cents: 1500 }];
  const [row] = computeChargedLineTotals(order, lines);
  assert.equal(row.chargedTotalCents, 4500);
  assert.equal(row.perUnitCents, 1500);
});

test("Phase 1 — 0-quantity line falls back to qty=1 to avoid divide-by-zero", () => {
  const order = { total_cents: 500 };
  const lines = [{ quantity: 0, price_cents: 500 }];
  const [row] = computeChargedLineTotals(order, lines);
  assert.equal(Number.isFinite(row.perUnitCents), true, "per-unit must be finite even for a 0-qty line");
});

// ── Named failing state (Phase 2 of docs/brain/specs/orchestrator-surfaces
// -line-item-variant-and-computed-per-unit-price.md) ────────────────────
// The pre-fix Sleep Gummies line item arrived to Sonnet as `Sleep Gummies
// x2` — no variant, no flavor — because the Shopify sync only stamps
// `variant_id` on the row (`originalUnitPriceSet` + variant.id, but NOT
// variant.title). The orchestrator was falling through to the empty-
// variant branch and the model was inferring 'Berry' from the product
// description. Asserted correct state: with the products.variants[].title
// pre-loaded into the map, resolveLineVariantTitle returns 'Berry'.
test("Phase 2 — Sleep Gummies: variant_id-only line resolves to 'Berry' via the products.variants map", () => {
  const map = new Map<string, string>([["gid-sleep-berry", "Berry"]]);
  const line = { title: "Sleep Gummies", variant_id: "gid-sleep-berry" };
  assert.equal(resolveLineVariantTitle(line, map), "Berry");
});

test("Phase 2 — stamped variant_title on the row wins over the resolved map", () => {
  const map = new Map<string, string>([["gid-x", "Vanilla (map-side)"]]);
  const line = { variant_title: "Chocolate", variant_id: "gid-x" };
  assert.equal(resolveLineVariantTitle(line, map), "Chocolate", "the row's stamped variant_title is the source of truth when present");
});

test("Phase 2 — variant_id with no products.variants match returns null (render omits parenthetical)", () => {
  const map = new Map<string, string>();
  const line = { variant_id: "gid-unknown" };
  assert.equal(resolveLineVariantTitle(line, map), null);
});

test("Phase 2 — a blank/whitespace variant_title falls through to the resolved map", () => {
  const map = new Map<string, string>([["gid-y", "Berry"]]);
  const line = { variant_title: "   ", variant_id: "gid-y" };
  assert.equal(resolveLineVariantTitle(line, map), "Berry", "an empty stamped variant_title should not shadow a real resolved title");
});

test("Phase 2 — line with no variant info at all returns null", () => {
  const map = new Map<string, string>([["gid-x", "Berry"]]);
  const line = {};
  assert.equal(resolveLineVariantTitle(line, map), null);
});
