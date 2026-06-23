/**
 * Unit tests for the PURE approval router (approval-routing-engine spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:approval-router
 *   (= tsx --test src/lib/agents/approval-router.test.ts)
 *
 * Exercises `resolveApprover` against fixture org-chart trees — the real chart is flat (every
 * director → CEO), but we also assert the generic UP-walk on a deeper tree to prove it routes to
 * an ancestor and never sideways/down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveApprover, isAutoApprover, CEO, type OrgChartGraph, type AutonomyMap } from "./approval-router";

// The real-world chart today: every director reports to the CEO (flat).
const FLAT: OrgChartGraph = {
  parentOf: { growth: CEO, cmo: CEO, retention: CEO, cs: CEO, platform: CEO },
};

// A hypothetical deeper chart to prove the generic ancestor-walk: logistics → cfo → CEO.
const DEEP: OrgChartGraph = {
  parentOf: { logistics: "cfo", cfo: CEO, platform: CEO },
};

const on = { live: true, autonomous: true };
const liveOnly = { live: true, autonomous: false };
const off = { live: false, autonomous: false };

test("all flags off ⇒ routes to CEO (fail-safe default)", () => {
  const autonomy: AutonomyMap = { platform: off, growth: off };
  assert.equal(resolveApprover("platform", FLAT, autonomy), CEO);
  assert.equal(resolveApprover("growth", FLAT, autonomy), CEO);
});

test("empty autonomy map (no rows) ⇒ routes to CEO", () => {
  assert.equal(resolveApprover("platform", FLAT, {}), CEO);
});

test("owner function live && autonomous ⇒ owner is the approver", () => {
  const autonomy: AutonomyMap = { platform: on };
  assert.equal(resolveApprover("platform", FLAT, autonomy), "platform");
});

test("live but NOT autonomous ⇒ falls through to CEO", () => {
  const autonomy: AutonomyMap = { platform: liveOnly };
  assert.equal(resolveApprover("platform", FLAT, autonomy), CEO);
});

test("a peer being live+autonomous never captures another function's approval (no sideways)", () => {
  const autonomy: AutonomyMap = { growth: on }; // growth is on, platform is off
  assert.equal(resolveApprover("platform", FLAT, autonomy), CEO);
});

test("deep tree: first live+autonomous ANCESTOR wins (routes UP)", () => {
  // logistics off, its parent cfo on ⇒ approver is cfo (the ancestor), not the CEO.
  const autonomy: AutonomyMap = { logistics: off, cfo: on };
  assert.equal(resolveApprover("logistics", DEEP, autonomy), "cfo");
});

test("deep tree: owner on takes precedence over an on ancestor (first match wins)", () => {
  const autonomy: AutonomyMap = { logistics: on, cfo: on };
  assert.equal(resolveApprover("logistics", DEEP, autonomy), "logistics");
});

test("deep tree: nobody on ⇒ CEO", () => {
  const autonomy: AutonomyMap = { logistics: off, cfo: off };
  assert.equal(resolveApprover("logistics", DEEP, autonomy), CEO);
});

test("unknown owner function ⇒ CEO (fail-safe)", () => {
  assert.equal(resolveApprover("nonexistent", FLAT, { nonexistent: on }), "nonexistent");
  // unknown AND not in autonomy map ⇒ no parent edge ⇒ CEO
  assert.equal(resolveApprover("ghost", FLAT, {}), CEO);
});

test("null / undefined / explicit CEO owner ⇒ CEO", () => {
  assert.equal(resolveApprover(null, FLAT, {}), CEO);
  assert.equal(resolveApprover(undefined, FLAT, {}), CEO);
  assert.equal(resolveApprover(CEO, FLAT, { ceo: on }), CEO);
});

test("cyclic chart is acyclic-safe ⇒ CEO, never loops", () => {
  const cyclic: OrgChartGraph = { parentOf: { a: "b", b: "a" } };
  assert.equal(resolveApprover("a", cyclic, { a: off, b: off }), CEO);
});

test("isAutoApprover requires BOTH flags", () => {
  assert.equal(isAutoApprover("x", { x: on }), true);
  assert.equal(isAutoApprover("x", { x: liveOnly }), false);
  assert.equal(isAutoApprover("x", { x: { live: false, autonomous: true } }), false);
  assert.equal(isAutoApprover("x", {}), false);
});
