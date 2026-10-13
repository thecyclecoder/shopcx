/**
 * `classifyObsoleteApproval` — Ada retires an approval that has nothing left to decide instead of
 * parking it on the CEO (CEO-authorized 2026-10-13: five of six CEO cards were this shape).
 *
 * Run: npx tsx --test src/lib/agents/platform-director.obsolete-approval.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyObsoleteApproval, OBSOLETE_DETECTOR_RETIRE_MAX, type DirectorTargetJob } from "@/lib/agents/platform-director";

const job = (kind: string, actions: Record<string, unknown>[]): DirectorTargetJob =>
  ({ id: "j1", workspace_id: "ws", kind, spec_slug: "s", pending_actions: actions }) as DirectorTargetJob;
const detector = { id: "a", type: "db_health_detector_review", status: "pending", already_shipped: true };
const broken = { id: "b", type: "broken_check", status: "pending" };
const fresh = { specFullyShipped: false, priorRetirements: 0 };

test("a detector re-fire on an already-shipped fix is obsolete", () => {
  assert.equal(classifyObsoleteApproval(job("db_health", [detector]), fresh).obsolete, true);
});

test("a detector signature retired the max number of times escalates instead", () => {
  const v = classifyObsoleteApproval(job("db_health", [detector]), { ...fresh, priorRetirements: OBSOLETE_DETECTOR_RETIRE_MAX });
  assert.equal(v.obsolete, false);
});

test("a real db_health build proposal is never retired", () => {
  assert.equal(classifyObsoleteApproval(job("db_health", [{ id: "c", type: "db_health_build", status: "pending" }]), fresh).obsolete, false);
});

test("broken checks on a fully shipped spec are obsolete", () => {
  assert.equal(classifyObsoleteApproval(job("build", [broken]), { ...fresh, specFullyShipped: true }).obsolete, true);
});

test("broken checks on a spec that hasn't fully shipped still escalate", () => {
  assert.equal(classifyObsoleteApproval(job("build", [broken]), fresh).obsolete, false);
});

test("a prod script, or a bundle mixing a broken check with a real action, is never retired", () => {
  const prod = { id: "d", type: "run_prod_script", status: "pending" };
  assert.equal(classifyObsoleteApproval(job("build", [prod]), { ...fresh, specFullyShipped: true }).obsolete, false);
  assert.equal(classifyObsoleteApproval(job("build", [broken, prod]), { ...fresh, specFullyShipped: true }).obsolete, false);
});

test("already-decided actions don't count; nothing pending is not obsolete", () => {
  assert.equal(classifyObsoleteApproval(job("db_health", [{ ...detector, status: "declined" }]), fresh).obsolete, false);
});
