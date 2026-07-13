/**
 * Unit tests for the canonical node registry (control-tower-canonical-node-registry P1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/node-registry.test.ts
 *
 * Focus (from the Phase 1 Verification checklist):
 * 1. Every `MONITORED_LOOPS` id resolves to a non-null `OwnerFunction` via `resolveNodeOwner`.
 * 2. Every `BUILDER_WORKER_KINDS` entry (the `agent_jobs.kind` universe emitted by
 *    `scripts/builder-worker.ts` `dispatchJob`) resolves to a non-null `OwnerFunction`.
 * 3. NO registered node's owner is the org-chart `ORPHAN_OWNER='platform'` DEFAULT
 *    (the audit-hook fallthrough). A node whose owner is `platform` is legitimate only when
 *    its declared MONITORED_LOOPS `owner` / `KIND_OWNER_FALLBACK` entry is `'platform'` — this
 *    check just makes sure `resolveNodeOwner` didn't SILENTLY default anything to platform.
 * 4. Fixture trees — the box worker resolves under `director:platform`; a `cs` MONITORED_LOOPS
 *    entry (e.g. `agent:ticket-handle`) resolves under `director:cs`; the CEO's `god-mode-cockpit`
 *    reactive resolves under `dept:ceo` via `director:ceo`.
 * 5. `assertCoverage()` throws on none of the above (the same invariant shipped as a callable).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILDER_WORKER_KINDS,
  RETIRED_KIND_OWNER,
  NODES,
  assertCoverage,
  getNode,
  getOrphanSightings,
  getParent,
  resetOrphanSightings,
  resolveNodeOwner,
  resolveNodeOwnerOrOrphanDefault,
  type OrgNode,
} from "./node-registry";
import { MONITORED_LOOPS, WORKER_BOX_ID, type OwnerFunction } from "./registry";
import { ownerFunctionForKind } from "@/lib/agents/approval-inbox";

test("every MONITORED_LOOPS id resolves to a non-null OwnerFunction (Phase 1 verification #1)", () => {
  const misses: string[] = [];
  for (const loop of MONITORED_LOOPS) {
    const owner = resolveNodeOwner(loop.id);
    if (!owner) misses.push(loop.id);
  }
  assert.deepEqual(misses, [], `expected zero MONITORED_LOOPS misses, got: ${misses.join(", ")}`);
});

test("every BUILDER_WORKER_KINDS entry resolves to a non-null OwnerFunction (Phase 1 verification #2)", () => {
  const misses: string[] = [];
  for (const kind of BUILDER_WORKER_KINDS) {
    const owner = resolveNodeOwner(kind);
    if (!owner) misses.push(kind);
  }
  assert.deepEqual(misses, [], `expected zero builder-worker kind misses, got: ${misses.join(", ")}`);
});

test("resolveNodeOwner never SILENTLY defaults an unregistered id to 'platform' (ORPHAN_OWNER fallthrough guard)", () => {
  // A truly unknown id must return null — not `'platform'`. The old ORPHAN_OWNER fallthrough
  // in [[../agents/org-chart]] silently defaulted an orphan to 'platform'; the whole point of
  // this registry is to surface that miss so Phase 2's `orphan_seen` audit counter can catch it.
  const bogusId = "definitely-not-a-real-node-id-xxx";
  assert.equal(resolveNodeOwner(bogusId), null);
});

test("fixture — the box worker resolves to owner='platform' under director:platform", () => {
  assert.equal(resolveNodeOwner(WORKER_BOX_ID), "platform");
  const node = getNode(WORKER_BOX_ID);
  assert.ok(node, "box worker must be a registered node");
  assert.equal(node!.parent, "director:platform");
  assert.equal(node!.kind, "tool");
  // Its parent must be the director:platform node, whose parent is dept:platform.
  const parent = getParent(WORKER_BOX_ID);
  assert.equal(parent?.id, "director:platform");
  assert.equal(parent?.kind, "director");
  const grand = getParent("director:platform");
  assert.equal(grand?.id, "dept:platform");
  assert.equal(grand?.kind, "department");
});

test("fixture — a cs MONITORED_LOOPS entry resolves to owner='cs' under director:cs", () => {
  const owner = resolveNodeOwner("agent:ticket-handle");
  assert.equal(owner, "cs");
  const node = getNode("agent:ticket-handle");
  assert.ok(node, "agent:ticket-handle must be registered");
  assert.equal(node!.parent, "director:cs");
  assert.equal(node!.owner, "cs");
});

test("fixture — the CEO's god-mode-cockpit resolves to owner='ceo' under director:ceo → dept:ceo", () => {
  const owner = resolveNodeOwner("god-mode-cockpit");
  assert.equal(owner, "ceo");
  const node = getNode("god-mode-cockpit");
  assert.ok(node, "god-mode-cockpit must be a registered node");
  assert.equal(node!.parent, "director:ceo");
  const parent = getParent("god-mode-cockpit");
  assert.equal(parent?.id, "director:ceo");
  assert.equal(parent?.owner, "ceo");
  const grand = getParent("director:ceo");
  assert.equal(grand?.id, "dept:ceo");
  assert.equal(grand?.owner, "ceo");
  assert.equal(grand?.kind, "department");
});

test("fixture — the god-mode agent-kind lane (Eve) also resolves to owner='ceo' (KIND_OWNER_FALLBACK)", () => {
  // `god-mode` is a builder-worker kind but is NOT a MONITORED_LOOPS agent-kind row (the
  // MONITORED_LOOPS entry is the reactive cockpit lane). It routes through the fallback
  // map to `ceo` so Eve's job runs report up to the CEO seat.
  assert.equal(resolveNodeOwner("god-mode"), "ceo");
});

test("fixture — director-grade routes to CEO (a director's own grading pass belongs to the CEO)", () => {
  // A director grades only its own charges; the CEO grades the directors — that's the
  // one KIND_OWNER_FALLBACK entry the north-star cascade depends on.
  assert.equal(resolveNodeOwner("director-grade"), "ceo");
});

test("fixture — agent-grade routes to Platform (Ada grades her own worker fleet)", () => {
  // The mirror invariant of the CEO-grades-directors rule: a director grades the layer
  // below it, so Ada's platform-worker sweep is owned by Platform.
  assert.equal(resolveNodeOwner("agent-grade"), "platform");
});

test("resolveNodeOwner accepts either a canonical node id OR a raw agent-kind slug", () => {
  // Phase 2 callers pass agent-kind slugs from `job.kind` (e.g. `build`); the pre-existing
  // MONITORED_LOOPS row for that kind is `agent:build`. The resolver must handle both.
  assert.equal(resolveNodeOwner("build"), "platform");
  assert.equal(resolveNodeOwner("agent:build"), "platform");
  assert.equal(resolveNodeOwner("ticket-handle"), "cs");
  assert.equal(resolveNodeOwner("agent:ticket-handle"), "cs");
});

test("every registered node has a resolvable parent or is a root department", () => {
  const ids = new Set(NODES.map((n) => n.id));
  const missing: Array<{ id: string; missing: string }> = [];
  for (const node of NODES) {
    if (node.parent === null) {
      assert.equal(node.kind, "department", `root node ${node.id} must be a department`);
      continue;
    }
    if (!ids.has(node.parent)) missing.push({ id: node.id, missing: node.parent });
  }
  assert.deepEqual(missing, [], `every parent must be a registered node: ${JSON.stringify(missing)}`);
});

test("every registered node's owner is a valid OwnerFunction (no undefined / empty)", () => {
  const validOwners = new Set<OwnerFunction>([
    "platform",
    "growth",
    "retention",
    "cs",
    "cmo",
    "cfo",
    "logistics",
    "ceo",
  ]);
  const bad: Array<{ id: string; owner: unknown }> = [];
  for (const node of NODES) {
    if (!validOwners.has(node.owner)) bad.push({ id: node.id, owner: node.owner });
  }
  assert.deepEqual(bad, [], `every node owner must be a valid OwnerFunction: ${JSON.stringify(bad)}`);
});

test("assertCoverage() throws on none of the above — the callable shipped for the Phase 3 drift check", () => {
  assert.doesNotThrow(() => assertCoverage());
});

test("Phase 1 verification #3 — a fixture kind absent from the registry surfaces as an unresolved lookup", () => {
  // The test-fixture assertion the spec Verification bullet #3 names — a `select distinct kind
  // from public.agent_jobs` returning a kind the registry does not carry must produce a null
  // owner (the audit hook then captures it). Simulated here with a bogus kind literal.
  const bogusKind = "not-a-real-kind-simulating-live-db-drift";
  assert.equal(resolveNodeOwner(bogusKind), null);
  // AND the pre-existing kinds do resolve, proving the assertion is a real drift signal
  // rather than a blanket-null failure.
  for (const real of ["build", "ticket-handle", "spec-test", "god-mode"]) {
    assert.ok(resolveNodeOwner(real), `real kind '${real}' must resolve`);
  }
});

test("Phase 1 — a RETIRED kind still resolves to its owner (historical agent_jobs rows keep it in `select distinct kind`)", () => {
  // A kind that left BUILDER_WORKER_KINDS + dispatch (e.g. `spec-review`, after Vale graduated to
  // the deterministic authoring gate) still appears in `select distinct kind from public.agent_jobs`
  // via historical rows. The live-kind coverage check (spec Phase 1 verification) requires every
  // returned kind to resolve — so RETIRED_KIND_OWNER must give each a resolvable owner even though
  // it is NOT dispatched. This is the rail that stops the `misses:["spec-review"]` false-fail from
  // recurring.
  assert.ok(Object.keys(RETIRED_KIND_OWNER).length > 0, "expected at least one retired kind");
  for (const [kind, owner] of Object.entries(RETIRED_KIND_OWNER)) {
    assert.equal(resolveNodeOwner(kind), owner, `retired kind '${kind}' must resolve to '${owner}'`);
    // ...and it must NOT be a dispatched kind (that's the whole point — retired ≠ dispatched).
    assert.ok(!BUILDER_WORKER_KINDS.includes(kind as (typeof BUILDER_WORKER_KINDS)[number]), `retired kind '${kind}' must not be in BUILDER_WORKER_KINDS`);
  }
});

test("registry snapshot — the 5 OWNER_FUNCTIONS + CEO + CFO + Logistics all have department seats", () => {
  const rootDepts = NODES.filter((n) => n.kind === "department").map((n) => n.id).sort();
  assert.deepEqual(
    rootDepts,
    ["dept:ceo", "dept:cfo", "dept:cmo", "dept:cs", "dept:growth", "dept:logistics", "dept:platform", "dept:retention"].sort(),
    "every OwnerFunction must have a department seat",
  );
});

test("registry snapshot — every director seat has a persona (a MascotId, not undefined)", () => {
  const missingPersona: string[] = [];
  for (const node of NODES) {
    if (node.kind !== "director") continue;
    if (!node.persona) missingPersona.push(node.id);
  }
  assert.deepEqual(missingPersona, [], `every director must have a persona: ${missingPersona.join(", ")}`);
});

// Regression pin — a MONITORED_LOOPS row owned by `cmo` (e.g. Piper's product-seed agent-kind
// lane) must NOT resolve to Platform (the ORPHAN_OWNER default the P1 spec explicitly guards
// against — a silent-Platform default is exactly the failure mode Phase 2 flips into an audit).
test("regression — a cmo-owned agent-kind lane does not silently default to platform", () => {
  const owner = resolveNodeOwner("agent:product-seed");
  assert.equal(owner, "cmo", `product-seed lane must resolve to owner='cmo', got: ${String(owner)}`);
});

// ── control-tower-canonical-node-registry Phase 2 verification ──────────────────────────────

test("P2 verification #3 — calling resolveNodeOwnerOrOrphanDefault on an unplaced node bumps getOrphanSightings()", () => {
  resetOrphanSightings();
  const bogusId = "phase2-fixture-unplaced-node-id";
  const owner = resolveNodeOwnerOrOrphanDefault(bogusId, "test:phase2-fixture");
  assert.equal(owner, "platform", "the historical default is preserved so callers don't break");
  const sightings = getOrphanSightings();
  assert.equal(sightings[bogusId], 1, `expected exactly 1 sighting for '${bogusId}', got: ${JSON.stringify(sightings)}`);
  // A second lookup increments again (proves the counter isn't idempotent-per-call — the audit
  // reads the raw count so it can size the surface).
  resolveNodeOwnerOrOrphanDefault(bogusId, "test:phase2-fixture");
  assert.equal(getOrphanSightings()[bogusId], 2);
});

test("P2 verification #3 — a REGISTERED node does NOT record a sighting", () => {
  resetOrphanSightings();
  const owner = resolveNodeOwnerOrOrphanDefault(WORKER_BOX_ID, "test:phase2-registered");
  assert.equal(owner, "platform");
  // The box worker IS registered → no sighting bump.
  assert.equal(getOrphanSightings()[WORKER_BOX_ID], undefined);
});

test("P2 verification #2 — a fixture kind absent from KIND_TO_FUNCTION_SHIM routes to the CEO seat (fail-safe unchanged)", () => {
  // ownerFunctionForKind consumes resolveNodeOwner FIRST, then the compact shim in
  // approval-inbox.ts. A kind absent from BOTH must return null so the approval router falls
  // through to the CEO — the fail-safe the spec Verification bullet #2 pins.
  assert.equal(ownerFunctionForKind("phase2-fixture-not-in-registry-not-in-shim"), null);
  // Sanity: the shim still routes its two carried entries (sms-marketing / growth-voice-angle-approval).
  assert.equal(ownerFunctionForKind("sms-marketing"), "cmo");
  assert.equal(ownerFunctionForKind("growth-voice-angle-approval"), "growth");
  // Sanity: the registry-backed lookups still work through ownerFunctionForKind.
  assert.equal(ownerFunctionForKind("build"), "platform");
  assert.equal(ownerFunctionForKind("ticket-handle"), "cs");
  assert.equal(ownerFunctionForKind("director-grade"), "ceo");
});

test("P2 — gradeableKindsForFunction owner-scoping now aligns with the canonical registry", () => {
  // Sanity: Ada's gradeable set includes platform-owned rubrics AND excludes cross-function ones.
  // The scoping used to go through approval-inbox's `ownerFunctionForKind`; now it consults
  // resolveNodeOwner directly, so a cross-function worker's owner cannot diverge between the two.
  const { gradeableKindsForFunction, GRADEABLE_KINDS } = require("@/lib/agents/agent-grader") as {
    gradeableKindsForFunction: (fn: string) => string[];
    GRADEABLE_KINDS: string[];
  };
  const platform = new Set(gradeableKindsForFunction("platform"));
  const cs = new Set(gradeableKindsForFunction("cs"));
  const cmo = new Set(gradeableKindsForFunction("cmo"));
  const retention = new Set(gradeableKindsForFunction("retention"));
  // A Platform rubric kind should land in Ada's set, not the CS one.
  assert.ok(platform.has("build"), "Ada must grade `build`");
  assert.ok(!cs.has("build"), "June must NOT grade `build`");
  // A CS rubric kind lands in June's set, not Platform's.
  assert.ok(cs.has("ticket-improve"), "June must grade `ticket-improve`");
  assert.ok(!platform.has("ticket-improve"), "Ada must NOT grade `ticket-improve`");
  // A CMO rubric kind (product-seed) lands in Iris's set, not Platform's.
  assert.ok(cmo.has("product-seed"), "Iris must grade `product-seed`");
  assert.ok(!platform.has("product-seed"), "Ada must NOT grade `product-seed`");
  // A Retention rubric kind (migration-fix) lands in Theo's set, not Platform's.
  assert.ok(retention.has("migration-fix"), "Theo must grade `migration-fix`");
  assert.ok(!platform.has("migration-fix"), "Ada must NOT grade `migration-fix`");
  // Every gradeable kind must belong to AT MOST one director's set (no cross-function drift). A
  // rubric kind whose owner is unregistered (e.g. `monitor` — a persona of a cron, not an
  // agent-kind row) belongs to ZERO sets on both the old and new logic, which is the intended
  // "unowned rubric" behavior — the ungraded-until-registered contract.
  for (const kind of GRADEABLE_KINDS) {
    const memberships = ["platform", "growth", "retention", "cs", "cmo"].filter((fn) =>
      gradeableKindsForFunction(fn).includes(kind),
    );
    assert.ok(memberships.length <= 1, `kind '${kind}' must be gradeable by AT MOST one director, got: ${memberships.join(", ")}`);
  }
});
