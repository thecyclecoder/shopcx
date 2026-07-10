/**
 * Pins the tiered-remediation ladder (PR2, cora-tiered-remediation-ladder-cheap-fail-resessions-sol-not-june).
 *
 * The ladder Dylan approved routes a mishandled ticket ONE RUNG at a time:
 *   - cheap-tier mishandle (Sonnet/Haiku handled it, Sol never did, ordinary verdict) → RE-SESSION Sol,
 *     do NOT escalate June (that's one rung too high, too early);
 *   - Sol-handled mishandle → escalate June (Sol's supervisor makes the call);
 *   - severe/threat verdict on a cheap-handled ticket → still escalate June (customer-risk override).
 * See [[ticket-analyzer]] decideRemediationTier + applySeverityActions, and [[cs-director-digest]]
 * composeMessyTurnWarnings (which rolls the cheap_tier_mishandle signal into an add_rule fix).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideRemediationTier } from "./ticket-analyzer";
import { SOL_MESSY_TURN_SIGNALS, normalizeMessyTurnSignals } from "./sol-coaching-signal";

test("cheap-tier mishandle (Sol never handled, ordinary verdict) → re-session Sol, not June", () => {
  assert.equal(decideRemediationTier({ solHandled: false, forceEscalate: false }), "resession_sol");
});

test("Sol-handled + Cora didn't like → escalate June (Sol's supervisor makes the call)", () => {
  assert.equal(decideRemediationTier({ solHandled: true, forceEscalate: false }), "escalate_june");
});

test("cheap-handled BUT a severe/threat verdict (forceEscalate) → still escalate June (customer-risk override)", () => {
  assert.equal(decideRemediationTier({ solHandled: false, forceEscalate: true }), "escalate_june");
});

test("Sol-handled AND severe/threat → escalate June (both paths already point up)", () => {
  assert.equal(decideRemediationTier({ solHandled: true, forceEscalate: true }), "escalate_june");
});

test("ladder never brings June in one rung too high: resession_sol is the SOLE cheap-handled-ordinary route", () => {
  const routes = [
    decideRemediationTier({ solHandled: false, forceEscalate: false }),
    decideRemediationTier({ solHandled: true, forceEscalate: false }),
    decideRemediationTier({ solHandled: false, forceEscalate: true }),
    decideRemediationTier({ solHandled: true, forceEscalate: true }),
  ];
  assert.equal(routes.filter((r) => r === "resession_sol").length, 1);
});

test("cheap_tier_mishandle is a first-class messy-turn vocab class (so June's digest groups + counts it)", () => {
  assert.ok(SOL_MESSY_TURN_SIGNALS.includes("cheap_tier_mishandle"));
});

test("cheap_tier_mishandle survives signal normalization (a real signal the ladder can emit)", () => {
  assert.deepEqual(normalizeMessyTurnSignals(["cheap_tier_mishandle"]), ["cheap_tier_mishandle"]);
});
