/**
 * Unit tests for the PURE analyzeInstanceHealth classifier
 * (db-health-instance-saturation-detector spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/db-health.test.ts
 *
 * Focus: replay the 2026-07-02 incident numbers (rollback ratio 0.0743, temp_bytes 883 GB, cache-hit
 * 0.9869 under load, `authenticated` statement_timeout=8s) and verify the classifier fires findings
 * whose cause ∈ {statement_timeout_pressure, temp_spill_pressure, rollback_error_rate} with the
 * offending numbers present in the evidence string — the miss the per-query slow-query pass could
 * never catch. A healthy fixture (rollback <1%, no temp spill, cache-hit >0.999) must return [].
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeInstanceHealth,
  type InstanceHealthInput,
  type DbHealthFinding,
} from "./db-health";

const GB = 1024 * 1024 * 1024;

/** The 2026-07-02 incident snapshot (the numbers cited in the spec). */
function incidentInput(): InstanceHealthInput {
  // rollback ratio 0.0743 → for total 1,000,000 tx we need ~74,300 rollbacks / ~925,700 commits.
  const xactCommit = 925_700;
  const xactRollback = 74_300;
  // cache-hit 0.9869 → for total 100,000,000 blks we need 98,690,000 hits / 1,310,000 reads.
  const blksHit = 98_690_000;
  const blksRead = 1_310_000;
  return {
    xactCommit,
    xactRollback,
    deadlocks: 12,
    tempFiles: 92_832,
    tempBytes: 883 * GB,
    blksHit,
    blksRead,
    activeBackends: 40,
    waitingBackends: 5,
    maxConnections: 100,
    statementsNearTimeout: 3,
    authenticatedStatementTimeoutMs: 8_000,
  };
}

/** A healthy instance — none of the flags trip. */
function healthyInput(): InstanceHealthInput {
  return {
    xactCommit: 990_000,
    xactRollback: 5_000, // 0.5% — under the 5% flag
    deadlocks: 0,
    tempFiles: 10,
    tempBytes: 1 * GB, // well under the 100 GB flag
    blksHit: 999_500,
    blksRead: 500, // cache-hit 0.9995 — above the 0.99 floor
    activeBackends: 5,
    waitingBackends: 0,
    maxConnections: 100,
    statementsNearTimeout: 0,
    authenticatedStatementTimeoutMs: 8_000,
  };
}

test("2026-07-02 incident fixture produces ≥1 finding whose cause ∈ {statement_timeout_pressure, temp_spill_pressure, rollback_error_rate}", () => {
  const findings = analyzeInstanceHealth(incidentInput());
  const incidentCauses = new Set(["statement_timeout_pressure", "temp_spill_pressure", "rollback_error_rate"]);
  const matches = findings.filter((f: DbHealthFinding) => incidentCauses.has(f.cause));
  assert.ok(
    matches.length >= 1,
    `expected ≥1 finding whose cause is one of ${[...incidentCauses].join(", ")}; got ${findings.map((f) => f.cause).join(", ") || "(none)"}`,
  );
});

test("incident evidence quotes the real numbers (rollback ratio, temp bytes, statement_timeout)", () => {
  const findings = analyzeInstanceHealth(incidentInput());

  const rollback = findings.find((f) => f.cause === "rollback_error_rate");
  assert.ok(rollback, "expected a rollback_error_rate finding");
  // rollback ratio 7.43% rounds to 7%
  assert.match(rollback!.evidence, /rollback ratio 7%/);
  assert.match(rollback!.evidence, /xact_rollback=74,300/);
  assert.match(rollback!.evidence, /xact_commit=925,700/);

  const tempSpill = findings.find((f) => f.cause === "temp_spill_pressure");
  assert.ok(tempSpill, "expected a temp_spill_pressure finding");
  assert.match(tempSpill!.evidence, /temp_files: 92,832/);
  assert.match(tempSpill!.evidence, /883 GB/);

  const timeout = findings.find((f) => f.cause === "statement_timeout_pressure");
  assert.ok(timeout, "expected a statement_timeout_pressure finding when statementsNearTimeout > 0");
  assert.match(timeout!.evidence, /statement_timeout` = 8000 ms/);
  assert.match(timeout!.evidence, /Live queries past 50% of the ceiling: 3/);
});

test("every incident finding is category='instance' and carries a stable dbhealth:instance:<cause> signature", () => {
  const findings = analyzeInstanceHealth(incidentInput());
  assert.ok(findings.length > 0, "expected findings on the incident fixture");
  for (const f of findings) {
    assert.equal(f.category, "instance", `${f.cause} should be category='instance'`);
    assert.match(f.signature, /^dbhealth:instance:/);
    assert.equal(f.signature, `dbhealth:instance:${f.cause}`);
  }
});

test("healthy fixture (rollback <1%, no temp spill, cache-hit >0.999) returns []", () => {
  const findings = analyzeInstanceHealth(healthyInput());
  assert.deepEqual(findings, []);
});

test("threshold overrides let the caller tune each flag independently", () => {
  // Take the incident numbers but raise every threshold above them — everything clears except
  // statement_timeout_pressure, which is driven by a live-query count (not a threshold).
  const findings = analyzeInstanceHealth(incidentInput(), {
    rollbackRatioFlag: 0.9,
    tempBytesWindowFlag: 10_000 * GB,
    cacheHitFloor: 0.5,
    connUtilFlag: 0.99,
  });
  const causes = findings.map((f) => f.cause);
  assert.deepEqual(causes, ["statement_timeout_pressure"]);
});

test("statement_timeout_pressure does NOT fire when the `authenticated` timeout is unset", () => {
  const input = incidentInput();
  input.authenticatedStatementTimeoutMs = null;
  input.statementsNearTimeout = 5; // even with waiters, no ceiling → no finding
  const findings = analyzeInstanceHealth(input);
  assert.equal(findings.find((f) => f.cause === "statement_timeout_pressure"), undefined);
});

test("connection_saturation fires when active+waiting cross the flag", () => {
  const input = healthyInput();
  input.activeBackends = 70;
  input.waitingBackends = 15; // 85% of 100 max_connections → over the 80% flag
  const findings = analyzeInstanceHealth(input);
  const conn = findings.find((f) => f.cause === "connection_saturation");
  assert.ok(conn, "expected connection_saturation over the 80% flag");
  assert.match(conn!.evidence, /85% utilization/);
});
