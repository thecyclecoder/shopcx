/**
 * Unit tests for the orphan-node self-audit (orphan-node-self-audit spec, Phase 1).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/self-audit.test.ts
 *
 * The audit's live form reads `public.kill_switches` + `public.loop_heartbeats` via an admin
 * client. `auditOrphanNodesWith` is the pure DI form the tests below exercise — every DB /
 * module-state read is behind a dep, so each fixture pins one branch of the three-way
 * finding (owner / switch / heartbeat) WITHOUT touching Supabase.
 *
 * Focus (from the Phase 1 Verification checklist):
 *   1. A fixture node with an owner but NO ancestor kill_switches row lands on orphanSwitch.
 *   2. A fixture registry entry whose parent is unresolved (a sighting from
 *      `resolveNodeOwnerOrOrphanDefault`) lands on orphanOwner.
 *   3. A fixture MONITORED_LOOPS entry with `registeredAt` older than its window and zero
 *      heartbeats since `registeredAt` lands on orphanHeartbeat.
 *   4. INTENTIONALLY_NO_SWITCH exempts the CEO seat from the switch sweep even when its
 *      cascade is empty (the CEO can't turn herself off — she IS the operator).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  INTENTIONALLY_NO_SWITCH,
  auditOrphanNodesWith,
  type AuditOrphanNodesDeps,
} from "./self-audit";
import type { KillSwitchMap, KillSwitchRow } from "./kill-switch-resolver";

// ── Fixture map builders ─────────────────────────────────────────────────────────

function switchRow(node_id: string): KillSwitchRow {
  return { node_id, scope: "department", off_by: "ceo", off_at: "2026-07-12T00:00:00Z", reason: null };
}

function switchMap(...rows: KillSwitchRow[]): KillSwitchMap {
  const m = new Map<string, KillSwitchRow>();
  for (const r of rows) m.set(r.node_id, r);
  return m;
}

/** Build a `deps` object with sensible defaults + a per-test override slice. */
function makeDeps(overrides: Partial<AuditOrphanNodesDeps> = {}): AuditOrphanNodesDeps {
  return {
    nodes: [],
    orphanSightings: {},
    killSwitchMap: switchMap(),
    loops: [],
    hasHeartbeatSinceRegistered: async () => false,
    now: Date.parse("2026-07-12T00:00:00Z"),
    ...overrides,
  };
}

// ── Phase 1 Verification bullets ─────────────────────────────────────────────────

test("V1 — a fixture node with owner but no ancestor kill_switches row lands on orphanSwitch", async () => {
  // `agent:ticket-handle` is a real cs-owned MONITORED_LOOPS lane. Its ancestor chain in the
  // canonical registry is `agent:ticket-handle → director:cs → dept:cs` — with an empty map
  // no ancestor carries a row → the audit flags it as never bound to a switch group.
  const deps = makeDeps({
    nodes: [{ id: "agent:ticket-handle" }],
    killSwitchMap: switchMap(),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanSwitch, ["agent:ticket-handle"]);
  assert.deepEqual(findings.orphanOwner, []);
  assert.deepEqual(findings.orphanHeartbeat, []);
});

test("V1 — adding an ancestor kill_switches row removes the node from orphanSwitch", async () => {
  const deps = makeDeps({
    nodes: [{ id: "agent:ticket-handle" }],
    // dept:cs has a row → agent:ticket-handle cascades under it → NOT orphaned.
    killSwitchMap: switchMap(switchRow("dept:cs")),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanSwitch, [], "the cascade should cover the leaf");
});

test("V2 — a fixture registry entry whose parent is unresolved shows up under orphanOwner", async () => {
  // The sighting counter is the source-of-truth: `resolveNodeOwnerOrOrphanDefault` bumps a
  // per-id count whenever the registry misses. The audit consumes that snapshot verbatim.
  const bogusId = "phase1-fixture-unregistered-parent";
  const deps = makeDeps({
    orphanSightings: { [bogusId]: 3 },
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanOwner, [bogusId]);
  assert.deepEqual(findings.orphanSwitch, []);
  assert.deepEqual(findings.orphanHeartbeat, []);
});

test("V3 — a fixture MONITORED_LOOPS entry registered older than its window with 0 beats lands on orphanHeartbeat", async () => {
  const registeredAt = "2026-07-11T00:00:00Z"; // 24h before `now`
  const HOUR = 60 * 60 * 1000;
  let probedLoop: string | null = null;
  let probedSince: string | null = null;
  const deps = makeDeps({
    loops: [{ id: "fixture-cron", registeredAt, livenessWindowMs: 2 * HOUR }],
    hasHeartbeatSinceRegistered: async (loopId, since) => {
      probedLoop = loopId;
      probedSince = since;
      return false; // 0 beats since registration
    },
    now: Date.parse("2026-07-12T00:00:00Z"),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanHeartbeat, ["fixture-cron"]);
  assert.equal(probedLoop, "fixture-cron", "the audit should probe the eligible loop by its id");
  assert.equal(probedSince, registeredAt, "the audit should probe from `registeredAt`, not from `now`");
});

test("V3 — a MONITORED_LOOPS entry whose registration window HASN'T fully elapsed is NOT audited", async () => {
  // A cron registered inside its own window is graced — no heartbeat probe fires yet.
  const registeredAt = "2026-07-11T23:00:00Z"; // 1h before `now`
  const HOUR = 60 * 60 * 1000;
  let probed = false;
  const deps = makeDeps({
    loops: [{ id: "fixture-fresh-cron", registeredAt, livenessWindowMs: 2 * HOUR }],
    hasHeartbeatSinceRegistered: async () => {
      probed = true;
      return false;
    },
    now: Date.parse("2026-07-12T00:00:00Z"),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanHeartbeat, [], "still inside its liveness window — not orphaned");
  assert.equal(probed, false, "the audit should skip the probe when the window hasn't elapsed");
});

test("V3 — a MONITORED_LOOPS entry with at-least-one beat since registeredAt is NOT orphaned", async () => {
  const registeredAt = "2026-07-11T00:00:00Z";
  const HOUR = 60 * 60 * 1000;
  const deps = makeDeps({
    loops: [{ id: "fixture-cron-with-beat", registeredAt, livenessWindowMs: 2 * HOUR }],
    hasHeartbeatSinceRegistered: async () => true, // beat found since registration
    now: Date.parse("2026-07-12T00:00:00Z"),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanHeartbeat, []);
});

test("V3 — a MONITORED_LOOPS entry with no `registeredAt` is skipped by the heartbeat audit", async () => {
  const HOUR = 60 * 60 * 1000;
  let probed = false;
  const deps = makeDeps({
    // No registeredAt → the audit can't measure elapsed time → skip silently.
    loops: [{ id: "legacy-cron-no-registeredAt", livenessWindowMs: 2 * HOUR }],
    hasHeartbeatSinceRegistered: async () => {
      probed = true;
      return false;
    },
    now: Date.parse("2026-07-12T00:00:00Z"),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.deepEqual(findings.orphanHeartbeat, []);
  assert.equal(probed, false, "no `registeredAt` ⇒ no heartbeat probe fires");
});

test("V4 — INTENTIONALLY_NO_SWITCH exempts the CEO seat from the switch sweep", async () => {
  // dept:ceo is on the allow-list — even with an empty cascade, it must NOT be flagged.
  assert.ok("dept:ceo" in INTENTIONALLY_NO_SWITCH, "dept:ceo must be permanently exempt");
  const deps = makeDeps({
    nodes: [{ id: "dept:ceo" }, { id: "dept:growth" }],
    killSwitchMap: switchMap(),
  });
  const findings = await auditOrphanNodesWith(deps);
  assert.ok(!findings.orphanSwitch.includes("dept:ceo"), "the CEO seat is never orphaned by the switch sweep");
  assert.ok(findings.orphanSwitch.includes("dept:growth"), "every OTHER department is legitimately switchable");
});

test("empty registry + empty sightings + no loops ⇒ all three lists are empty (no false RED)", async () => {
  const findings = await auditOrphanNodesWith(makeDeps());
  assert.deepEqual(findings, { orphanOwner: [], orphanSwitch: [], orphanHeartbeat: [] });
});
