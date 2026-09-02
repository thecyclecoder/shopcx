/**
 * escalation-health — pin the five states of `classifyEscalationHealth`.
 *
 * The behavior under test is the neglect-not-age rule from spec
 * `a-reopened-ticket-is-not-a-dropped-hand-off`: an old ticket that a customer
 * reopened one minute ago is NOT a dropped hand-off, but an old ticket nobody
 * has touched inside the grace window IS.
 *
 *   npx tsx --test src/lib/escalation-health.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyEscalationHealth } from "./escalation-health";

const GRACE = 30;

test("escalated → CEO — dominates every other signal", () => {
  const r = classifyEscalationHealth({
    ageMin: 100_000,
    idleMin: 100_000,
    escalatedTo: "ceo",
    assignedTo: "some-uuid",
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "escalated" });
});

test("assigned → human-worked — an assigned ticket is owned, not a defect, even if very old + very idle", () => {
  const r = classifyEscalationHealth({
    ageMin: 60_000,
    idleMin: 60_000,
    escalatedTo: null,
    assignedTo: "human-uuid",
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "assigned" });
});

test("brand new (age within the grace) → not a defect", () => {
  const r = classifyEscalationHealth({
    ageMin: 5,
    idleMin: 5,
    escalatedTo: null,
    assignedTo: null,
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "new", ageMin: 5 });
});

test("new-boundary — ageMin == graceMin still counts as new (inclusive lower bound)", () => {
  const r = classifyEscalationHealth({
    ageMin: 30,
    idleMin: 30,
    escalatedTo: null,
    assignedTo: null,
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "new", ageMin: 30 });
});

test("reopened (the 2026-09-02 shape — age 7.9d, idle 1m) → NOT a defect", () => {
  // 7.9 days ≈ 11376 minutes; agent replied 1 minute ago.
  const r = classifyEscalationHealth({
    ageMin: 11_376,
    idleMin: 1,
    escalatedTo: null,
    assignedTo: null,
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "reopened", idleMin: 1 });
});

test("reopened-boundary — old ticket, idleMin == graceMin still counts as reopened-in-flow", () => {
  const r = classifyEscalationHealth({
    ageMin: 5_000,
    idleMin: 30,
    escalatedTo: null,
    assignedTo: null,
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "reopened", idleMin: 30 });
});

test("defect — old AND untouched past the grace → dropped hand-off", () => {
  const r = classifyEscalationHealth({
    ageMin: 240,
    idleMin: 240,
    escalatedTo: null,
    assignedTo: null,
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "defect", idleMin: 240 });
});

test("defect-boundary — idleMin one minute past the grace still fires", () => {
  const r = classifyEscalationHealth({
    ageMin: 60,
    idleMin: 31,
    escalatedTo: null,
    assignedTo: null,
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "defect", idleMin: 31 });
});

test("assigned dominates the age/idle bucket — an assigned reopened ticket is still assigned, not reopened", () => {
  const r = classifyEscalationHealth({
    ageMin: 11_376,
    idleMin: 1,
    escalatedTo: null,
    assignedTo: "human-uuid",
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "assigned" });
});

test("escalated dominates assigned + defect too — precedence is escalated > assigned > age/idle bucket", () => {
  const r = classifyEscalationHealth({
    ageMin: 5_000,
    idleMin: 5_000,
    escalatedTo: "ceo",
    assignedTo: "human-uuid",
    graceMin: GRACE,
  });
  assert.deepEqual(r, { state: "escalated" });
});
