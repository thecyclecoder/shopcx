/**
 * Unit tests for the shared execution-time kill-switch guard (Phase 1).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/enforce-switch.test.ts
 *
 * The guard's live form calls into `resolveEffectiveSwitch` (module-level TTL cache) + the
 * best-effort `emitLoopHeartbeat` (real Supabase INSERT). The tests below exercise the DI-shaped
 * `enforceSwitchWith` so cascade + beat-shape can be pinned WITHOUT touching the DB — mirrors
 * the fixture-only pattern in [[./kill-switch-resolver.test]].
 *
 * Focus (from the Phase 1 Verification checklist):
 *   1. A department-off cascades to every descendant call site — the returned verdict AND the
 *      emitted beat carry `offBy:'growth', scope:'department'`.
 *   2. The emitter is picked BY NODE KIND — a cron site writes a `cron` beat; a reactive site
 *      writes a `reactive` beat; an inline-agent site writes an `inline-agent` beat; an
 *      agent-kind site writes an `agent-kind` beat; a tool (box worker) writes a `worker` beat.
 *   3. Sibling isolation — a `director:growth` row does NOT block a growth-sibling `cs`-owned
 *      site.
 *   4. Fail-open — an unknown nodeId returns `{ ok:'run' }`, no beat.
 *   5. Fail-open — if the resolver throws, the guard returns `{ ok:'run' }`, no beat.
 *   6. No beat when NOT blocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { enforceSwitchWith, type EnforceSwitchDeps } from "./enforce-switch";
import {
  resolveEffectiveSwitchFromMap,
  type KillSwitchMap,
  type KillSwitchRow,
} from "./kill-switch-resolver";
import type { HeartbeatInput } from "./heartbeat";
import type { LoopKind } from "./registry";

// ── Fixture map builders ─────────────────────────────────────────────────────────

function row(node_id: string, scope: KillSwitchRow["scope"], off_by = "ceo"): KillSwitchRow {
  return { node_id, scope, off_by, off_at: "2026-07-12T00:00:00Z", reason: null };
}

function mapOf(...rows: KillSwitchRow[]): KillSwitchMap {
  const m = new Map<string, KillSwitchRow>();
  for (const r of rows) m.set(r.node_id, r);
  return m;
}

interface EmitCall {
  loopId: string;
  kind: LoopKind;
  input: HeartbeatInput;
}

function makeDeps(map: KillSwitchMap): { deps: EnforceSwitchDeps; emits: EmitCall[] } {
  const emits: EmitCall[] = [];
  const deps: EnforceSwitchDeps = {
    resolve: async (id) => resolveEffectiveSwitchFromMap(id, map),
    emit: async (loopId, kind, input) => {
      emits.push({ loopId, kind, input });
    },
  };
  return { deps, emits };
}

// ── Cascade + observable off-beat ────────────────────────────────────────────────

test("cascade — a `growth` department-off blocks a growth-owned cron and emits a matching beat", async () => {
  const { deps, emits } = makeDeps(mapOf(row("growth", "department")));
  const result = await enforceSwitchWith("media-buyer-cadence-cron", deps);
  assert.deepEqual(result, { ok: "blocked_off", offBy: "growth", scope: "department" });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].loopId, "media-buyer-cadence-cron");
  assert.equal(emits[0].kind, "cron"); // cron NodeKind → `cron` LoopKind
  assert.deepEqual(emits[0].input.produced, { blocked_off: true, offBy: "growth", scope: "department" });
  assert.equal(emits[0].input.ok, true); // off is intentional, not an error
});

test("cascade — a `cs` department-off blocks the unified-ticket-handler reactive fn with a `reactive` beat", async () => {
  // The Phase 2 verification-checklist scenario: switching off `cs` must halt inbound tickets.
  const { deps, emits } = makeDeps(mapOf(row("cs", "department")));
  const result = await enforceSwitchWith("unified-ticket-handler", deps);
  assert.deepEqual(result, { ok: "blocked_off", offBy: "cs", scope: "department" });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].loopId, "unified-ticket-handler");
  assert.equal(emits[0].kind, "reactive"); // reactive NodeKind → `reactive` LoopKind
  assert.deepEqual(emits[0].input.produced, { blocked_off: true, offBy: "cs", scope: "department" });
});

test("cascade — a `cs` department-off blocks the ai:ticket-analyzer inline agent with an `inline-agent` beat", async () => {
  const { deps, emits } = makeDeps(mapOf(row("cs", "department")));
  const result = await enforceSwitchWith("ai:ticket-analyzer", deps);
  assert.deepEqual(result, { ok: "blocked_off", offBy: "cs", scope: "department" });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].loopId, "ai:ticket-analyzer");
  assert.equal(emits[0].kind, "inline-agent");
});

test("cascade — a `platform` department-off blocks agent:build with an `agent-kind` beat", async () => {
  const { deps, emits } = makeDeps(mapOf(row("platform", "department")));
  const result = await enforceSwitchWith("agent:build", deps);
  assert.deepEqual(result, { ok: "blocked_off", offBy: "platform", scope: "department" });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].kind, "agent-kind"); // agent NodeKind → `agent-kind` LoopKind
});

test("cascade — a `platform` department-off blocks the box worker (tool) with a `worker` beat", async () => {
  // The box worker is a `tool` NodeKind; the tool executors Phase 3 wires up also register as
  // `tool` nodes. A `tool` block should write a `worker` LoopKind beat.
  const { deps, emits } = makeDeps(mapOf(row("platform", "department")));
  const result = await enforceSwitchWith("box", deps);
  assert.deepEqual(result, { ok: "blocked_off", offBy: "platform", scope: "department" });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].kind, "worker");
});

// ── Sibling isolation ────────────────────────────────────────────────────────────

test("sibling isolation — a `director:growth` off does NOT block a cs-owned site", async () => {
  const { deps, emits } = makeDeps(mapOf(row("director:growth", "director")));
  const result = await enforceSwitchWith("unified-ticket-handler", deps);
  assert.deepEqual(result, { ok: "run" });
  assert.equal(emits.length, 0);
});

// ── Fail-open behavior ──────────────────────────────────────────────────────────

test("fail-open — an unknown node returns { ok:'run' } and does NOT emit a beat", async () => {
  const { deps, emits } = makeDeps(mapOf(row("growth", "department")));
  const result = await enforceSwitchWith("definitely-not-a-real-node-id-xxx", deps);
  assert.deepEqual(result, { ok: "run" });
  assert.equal(emits.length, 0);
});

test("fail-open — a thrown resolver returns { ok:'run' } and does NOT emit a beat", async () => {
  const emits: EmitCall[] = [];
  const deps: EnforceSwitchDeps = {
    resolve: async () => {
      throw new Error("simulated pooler blip");
    },
    emit: async (loopId, kind, input) => {
      emits.push({ loopId, kind, input });
    },
  };
  const result = await enforceSwitchWith("media-buyer-cadence-cron", deps);
  assert.deepEqual(result, { ok: "run" });
  assert.equal(emits.length, 0);
});

test("no block, no beat — a clean map runs and does NOT emit anything", async () => {
  const { deps, emits } = makeDeps(mapOf()); // empty map: nothing is off
  const result = await enforceSwitchWith("media-buyer-cadence-cron", deps);
  assert.deepEqual(result, { ok: "run" });
  assert.equal(emits.length, 0);
});

// ── Attribution passthrough ─────────────────────────────────────────────────────

test("attribution — the emitted beat's `offBy` mirrors the stored key form (canonical vs bare slug)", async () => {
  // Bare slug form: `growth` — the beat carries `offBy:'growth'` verbatim.
  {
    const { deps, emits } = makeDeps(mapOf(row("growth", "department")));
    await enforceSwitchWith("media-buyer-cadence-cron", deps);
    assert.equal(emits[0].input.produced && (emits[0].input.produced as { offBy: string }).offBy, "growth");
  }
  // Canonical form: `dept:growth` — the beat carries `offBy:'dept:growth'` verbatim.
  {
    const { deps, emits } = makeDeps(mapOf(row("dept:growth", "department")));
    await enforceSwitchWith("media-buyer-cadence-cron", deps);
    assert.equal(emits[0].input.produced && (emits[0].input.produced as { offBy: string }).offBy, "dept:growth");
  }
});

test("attribution — a leaf-scope off (a single cron) blocks ONLY that cron, carrying the leaf id + scope", async () => {
  const { deps, emits } = makeDeps(mapOf(row("media-buyer-cadence-cron", "tool")));
  const blocked = await enforceSwitchWith("media-buyer-cadence-cron", deps);
  assert.deepEqual(blocked, { ok: "blocked_off", offBy: "media-buyer-cadence-cron", scope: "tool" });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].kind, "cron");
  // Sibling cron under the same director is unaffected.
  const { deps: deps2, emits: emits2 } = makeDeps(mapOf(row("media-buyer-cadence-cron", "tool")));
  const sibling = await enforceSwitchWith("ad-creative-cadence-cron", deps2);
  assert.deepEqual(sibling, { ok: "run" });
  assert.equal(emits2.length, 0);
});

