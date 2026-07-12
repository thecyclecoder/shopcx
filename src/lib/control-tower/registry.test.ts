/**
 * Unit tests for `assertRegistryInvariants` + `MONITOR_TICK_FLOOR_MS`
 * (monitor-cadence-scaled-liveness-window spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/registry.test.ts
 *
 * Focus: the two throw paths of the invariant (window-too-tight, cadence-below-floor)
 * on fixtures, so a regression in the assertion logic is caught deterministically.
 * The "over the current MONITORED_LOOPS list" check is Phase 2's job — Phase 2 widens
 * the offending existing rows and promotes the bootstrap try/catch to a hard throw.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRegistryInvariants,
  MONITOR_TICK_FLOOR_MS,
  REGISTRY_LIVENESS_JITTER_GRACE,
  type MonitoredLoop,
} from "./registry";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("MONITOR_TICK_FLOOR_MS is 5 min — matches the pinned control-tower-monitor tick", () => {
  assert.equal(MONITOR_TICK_FLOOR_MS, 5 * MIN);
});

test("assertRegistryInvariants passes on a well-formed fixture (every 5m cron, 20m window)", () => {
  const loops: MonitoredLoop[] = [
    {
      id: "fixture-ok-every-5m",
      kind: "cron",
      owner: "platform",
      label: "fixture ok",
      description: "fixture",
      expectedCadence: "every 5 min (*/5 * * * *)",
      livenessWindowMs: 20 * MIN,
    },
  ];
  assert.doesNotThrow(() => assertRegistryInvariants(loops));
});

test("assertRegistryInvariants throws on a daily cron with a 15-min window", () => {
  const loops: MonitoredLoop[] = [
    {
      id: "fixture-daily-tight-window",
      kind: "cron",
      owner: "platform",
      label: "fixture tight",
      description: "fixture",
      expectedCadence: "daily (0 4 * * *)",
      livenessWindowMs: 15 * MIN,
    },
  ];
  assert.throws(
    () => assertRegistryInvariants(loops),
    /livenessWindowMs .* < cadence/,
  );
});

test("assertRegistryInvariants throws naming MONITOR_TICK_FLOOR_MS on an every-minute cron", () => {
  const loops: MonitoredLoop[] = [
    {
      id: "fixture-every-minute",
      kind: "cron",
      owner: "platform",
      label: "fixture every-minute",
      description: "fixture",
      expectedCadence: "every minute (* * * * *)",
      livenessWindowMs: 10 * MIN,
    },
  ];
  assert.throws(
    () => assertRegistryInvariants(loops),
    /MONITOR_TICK_FLOOR_MS/,
  );
});

test("assertRegistryInvariants skips non-cron kinds and unparseable cadences", () => {
  const loops: MonitoredLoop[] = [
    // worker — no cron, skipped
    {
      id: "fixture-worker",
      kind: "worker",
      owner: "platform",
      label: "fixture worker",
      description: "fixture",
      expectedCadence: "polls every ~5s",
      livenessWindowMs: 5 * MIN,
    },
    // box-job cron — no parseable expression, skipped
    {
      id: "fixture-box-job",
      kind: "cron",
      owner: "platform",
      label: "fixture box job",
      description: "fixture",
      expectedCadence: "every ~30 min (box job)",
      livenessWindowMs: 90 * MIN,
    },
    // agent-kind — no cron, skipped
    {
      id: "agent:fixture",
      kind: "agent-kind",
      owner: "platform",
      agentKind: "fixture",
      label: "fixture agent",
      description: "fixture",
      expectedCadence: "on demand",
      stuckThresholdMs: 60 * MIN,
    },
    // reactive — no cron, skipped
    {
      id: "fixture-reactive",
      kind: "reactive",
      owner: "platform",
      label: "fixture reactive",
      description: "fixture",
      expectedCadence: "per event",
      livenessWindowMs: 12 * HOUR,
    },
  ];
  assert.doesNotThrow(() => assertRegistryInvariants(loops));
});

test("assertRegistryInvariants accepts a cadence exactly at the floor with a grace-scaled window", () => {
  const loops: MonitoredLoop[] = [
    {
      id: "fixture-at-floor",
      kind: "cron",
      owner: "platform",
      label: "fixture at floor",
      description: "fixture",
      expectedCadence: "every 5 min (*/5 * * * *)",
      livenessWindowMs: Math.ceil(MONITOR_TICK_FLOOR_MS * REGISTRY_LIVENESS_JITTER_GRACE),
    },
  ];
  assert.doesNotThrow(() => assertRegistryInvariants(loops));
});

test("assertRegistryInvariants throws when livenessWindowMs is undefined on a cron loop", () => {
  const loops: MonitoredLoop[] = [
    {
      id: "fixture-no-window",
      kind: "cron",
      owner: "platform",
      label: "fixture no window",
      description: "fixture",
      expectedCadence: "hourly (0 * * * *)",
      // livenessWindowMs deliberately absent
    },
  ];
  assert.throws(
    () => assertRegistryInvariants(loops),
    /livenessWindowMs undefined/,
  );
});
