/**
 * reconcile-conflict-route-to-pr-resolve — the escort's pure lane decision for a build parked on a
 * reconcile_conflict. A blind failed_retry rebuild re-hits the IDENTICAL deterministic branch↔main conflict
 * and re-parks (the dahlia-never-fabricate-copy-firewall stall: 3 re-attempts, 3 re-parks). The escort must
 * instead route to pr-resolve (resolve the branch), then rebuild ONLY once the branch is reconciled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { routeReconcileConflictPark } from "./platform-director";

test("reconcile_conflict + PR + no resolve yet → enqueue a pr-resolve (not a blind rebuild)", () => {
  assert.equal(routeReconcileConflictPark("reconcile_conflict", 1982, "none"), "reconcile_resolve");
});

test("reconcile_conflict + PR + a resolve IN-FLIGHT → skip (wait, don't double-enqueue or rebuild)", () => {
  assert.equal(routeReconcileConflictPark("reconcile_conflict", 1982, "inflight"), "skip");
});

test("reconcile_conflict + PR + a resolve COMPLETED → rebuild on the reconciled branch", () => {
  assert.equal(routeReconcileConflictPark("reconcile_conflict", 1982, "resolved"), "failed_retry");
});

test("reconcile_conflict WITHOUT a PR → null (falls through to the normal failedCount lanes)", () => {
  assert.equal(routeReconcileConflictPark("reconcile_conflict", null, "none"), null);
});

test("a DIFFERENT park class (base_poison / generic fail) → null (not this lane's concern)", () => {
  assert.equal(routeReconcileConflictPark("base_poison", 1982, "none"), null);
  assert.equal(routeReconcileConflictPark(null, 1982, "none"), null);
});
