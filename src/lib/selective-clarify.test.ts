/**
 * Unit tests for shouldClarify — the Phase-2 gate of
 * docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md.
 *
 * The spec pins two behaviors:
 *   - low confidence × irreversible partial_refund → clarify (verified_outcome='clarified')
 *   - low confidence × reversible apply_coupon    → do NOT clarify (execute as-is)
 * We pin both here so a future refactor can't quietly widen the gate to the ~38%
 * blanket-clarify regime the goal rejects. Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/selective-clarify.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CLARIFY_CONFIDENCE_THRESHOLD,
  DEFAULT_IRREVERSIBLE_SET,
  buildClarificationMessage,
  shouldClarify,
} from "./selective-clarify";

test("low confidence × irreversible partial_refund → clarify", () => {
  const clarify = shouldClarify({
    confidence: 0.4,
    actions: [{ type: "partial_refund", amount_cents: 2000 }],
  });
  assert.equal(clarify, true, "must gate a low-confidence partial_refund");
});

test("low confidence × reversible apply_coupon → do NOT clarify (reversibility wins)", () => {
  const clarify = shouldClarify({
    confidence: 0.4,
    actions: [{ type: "apply_coupon" }],
  });
  assert.equal(clarify, false, "reversible action must NOT be gated even at low confidence");
});

test("HIGH confidence × irreversible partial_refund → do NOT clarify (confidence wins)", () => {
  const clarify = shouldClarify({
    confidence: 0.9,
    actions: [{ type: "partial_refund", amount_cents: 2000 }],
  });
  assert.equal(clarify, false, "at high confidence we execute even irreversible actions");
});

test("null/absent confidence is treated as HIGH (no clarify) — do not blanket-clarify a straggler decision", () => {
  const clarify = shouldClarify({
    confidence: null,
    actions: [{ type: "partial_refund" }],
  });
  assert.equal(clarify, false, "a missing confidence must not trigger the ~38% blanket regime");
});

test("mixed batch: one irreversible + reversible → clarify (any irreversible in the batch fires the gate)", () => {
  const clarify = shouldClarify({
    confidence: 0.3,
    actions: [{ type: "apply_coupon" }, { type: "cancel" }],
  });
  assert.equal(clarify, true);
});

test("default set covers partial_refund, cancel, bill_now, subscriptionOrderNow — the spec's IRREVERSIBLE_SET", () => {
  for (const t of ["partial_refund", "cancel", "bill_now", "subscriptionOrderNow"]) {
    assert.equal(DEFAULT_IRREVERSIBLE_SET.has(t), true, `${t} must be in the default irreversible set`);
  }
});

test("custom irreversibleSet override — DB-configurable via policies", () => {
  const custom = new Set(["custom_dangerous"]);
  assert.equal(shouldClarify({ confidence: 0.3, actions: [{ type: "partial_refund" }] }, { irreversibleSet: custom }), false,
    "custom set replaces the default — partial_refund no longer gated");
  assert.equal(shouldClarify({ confidence: 0.3, actions: [{ type: "custom_dangerous" }] }, { irreversibleSet: custom }), true,
    "custom action type is gated");
});

test("default clarify threshold aligns with the problem-lockin default 0.7", () => {
  assert.equal(DEFAULT_CLARIFY_CONFIDENCE_THRESHOLD, 0.7);
});

test("buildClarificationMessage — dollar-amounts render, plain refund fallback works, no markdown", () => {
  assert.match(
    buildClarificationMessage([{ type: "partial_refund", amount_cents: 2000 }]),
    /Just to confirm before I refund \$20\.00, is that right\?/,
  );
  assert.match(
    buildClarificationMessage([{ type: "cancel" }]),
    /Just to confirm before I cancel your subscription, is that right\?/,
  );
  assert.match(
    buildClarificationMessage([{ type: "bill_now" }]),
    /Just to confirm before I bill your next order now, is that right\?/,
  );
  const msg = buildClarificationMessage([{ type: "partial_refund", amount_cents: 2000 }]);
  assert.doesNotMatch(msg, /\*\*/, "no markdown");
});
