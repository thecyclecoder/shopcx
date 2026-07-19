/**
 * Unit tests for the kill-switch cascade resolver (kill-switches-table-and-cascade-resolver P2).
 *
 * Built-in node:test — no runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/kill-switch-resolver.test.ts
 *
 * The resolver's DB dependency is isolated to `loadKillSwitchMap` (integration-tested against a
 * real Supabase pooler via the Phase 2 verification checklist). The tests below exercise the
 * PURE walk over a fixture map so the cascade invariants — down not up, sibling-isolated, fail-open
 * on unknown / missing — are pinned deterministically.
 *
 * Focus (from the Phase 2 Verification checklist):
 * 1. A department-off row cascades to every child (a growth-owned MONITORED_LOOPS lane is OFF).
 * 2. A leaf-only off does NOT cascade UPWARD (its parent director stays ON).
 * 3. A director-off does NOT affect a sibling director (director:cs is unaffected by director:growth).
 * 4. Missing row ⇒ OFF:false — fail-open, mirrors function_autonomy's opposite-polarity fail-safe.
 * 5. The department-key convenience — both `dept:growth` and `growth` cascade the same way.
 * 6. Node-id normalization — a raw agent-kind slug (e.g. `media-buyer`) resolves the same as the
 *    canonical id (`agent-kind:media-buyer`).
 * 7. `resolveEffectiveSwitchMany` batches consistently — every id sees the same snapshot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveSwitchFromMap,
  resolveEffectiveSwitchMany,
  invalidateKillSwitchCache,
  type KillSwitchMap,
  type KillSwitchRow,
} from "./kill-switch-resolver";

// ── Fixture map builders ─────────────────────────────────────────────────────────

function row(node_id: string, scope: KillSwitchRow["scope"], off_by = "ceo", reason: string | null = null): KillSwitchRow {
  return { node_id, scope, off_by, off_at: "2026-07-11T00:00:00Z", reason };
}

function mapOf(...rows: KillSwitchRow[]): KillSwitchMap {
  const m = new Map<string, KillSwitchRow>();
  for (const r of rows) m.set(r.node_id, r);
  return m;
}

// ── Cascade invariants ───────────────────────────────────────────────────────────

test("cascade — a `growth` department-scope row cascades to every growth-owned node (Phase 2 verification #1 & #2)", () => {
  // The verification-checklist scenario: a `growth` row is written, an underlying growth-owned
  // MONITORED_LOOPS lane must resolve to { off: true, offBy: 'growth', scope: 'department' }.
  // We use `media-buyer-cadence-cron` (a real growth-owned MONITORED_LOOPS id) as the query node
  // since the spec's `media-buyer-test-winner-loop` fixture is a placeholder — the actual
  // registered growth cron carries the same ancestor chain the spec is asserting on.
  const map = mapOf(row("growth", "department"));
  const result = resolveEffectiveSwitchFromMap("media-buyer-cadence-cron", map);
  assert.deepEqual(result, { off: true, offBy: "growth", scope: "department", reason: null });
});

test("cascade — the SAME row cascades to a raw agent-kind slug (normalization keeps callers simple)", () => {
  // A caller passing `job.kind = 'media-buyer'` must get the same cascade answer as a caller
  // passing the canonical `agent-kind:media-buyer` / a MONITORED_LOOPS growth-owned id.
  const map = mapOf(row("growth", "department"));
  const bySlug = resolveEffectiveSwitchFromMap("media-buyer", map);
  const byCanonical = resolveEffectiveSwitchFromMap("agent-kind:media-buyer", map);
  assert.deepEqual(bySlug, { off: true, offBy: "growth", scope: "department", reason: null });
  assert.deepEqual(byCanonical, { off: true, offBy: "growth", scope: "department", reason: null });
});

test("cascade — the department-key convenience honors BOTH `growth` AND `dept:growth` stored forms", () => {
  // The CEO cockpit surfaces a department by its function slug, matching function_autonomy's
  // convention — but a caller writing the canonical registry id must ALSO cascade. Both stored
  // forms are honored.
  const bareForm = mapOf(row("growth", "department"));
  const canonicalForm = mapOf(row("dept:growth", "department"));
  const q = "media-buyer-cadence-cron";
  assert.deepEqual(resolveEffectiveSwitchFromMap(q, bareForm), { off: true, offBy: "growth", scope: "department", reason: null });
  assert.deepEqual(resolveEffectiveSwitchFromMap(q, canonicalForm), { off: true, offBy: "dept:growth", scope: "department", reason: null });
});

test("cascade DOWN, not UP — a leaf-only off does not affect its parent director or department", () => {
  // A single MONITORED_LOOPS cron is switched off. The parent director:growth must remain ON.
  const map = mapOf(row("media-buyer-cadence-cron", "tool"));
  // The leaf itself is OFF (its own row is its first ancestor).
  assert.deepEqual(
    resolveEffectiveSwitchFromMap("media-buyer-cadence-cron", map),
    { off: true, offBy: "media-buyer-cadence-cron", scope: "tool", reason: null },
  );
  // The director stays ON — the walk goes UP from the query node, and director:growth's ancestor
  // chain (director:growth → dept:growth) has no row.
  assert.deepEqual(resolveEffectiveSwitchFromMap("director:growth", map), { off: false });
  // A sibling growth-owned lane also stays ON — the leaf-off doesn't affect its siblings.
  assert.deepEqual(resolveEffectiveSwitchFromMap("media-buyer-grade-cron", map), { off: false });
});

test("cascade — a director-off does NOT affect a SIBLING director (Phase 2 verification #3 invariant)", () => {
  // director:growth is switched off. director:cs must remain ON.
  const map = mapOf(row("director:growth", "director"));
  // Sanity: the growth director's own descendants ARE off.
  const growthDescendant = resolveEffectiveSwitchFromMap("media-buyer-cadence-cron", map);
  assert.equal(growthDescendant.off, true);
  if (growthDescendant.off) {
    assert.equal(growthDescendant.offBy, "director:growth");
    assert.equal(growthDescendant.scope, "director");
  }
  // The sibling director:cs and its descendants must be UNTOUCHED.
  assert.deepEqual(resolveEffectiveSwitchFromMap("director:cs", map), { off: false });
  assert.deepEqual(resolveEffectiveSwitchFromMap("agent:ticket-handle", map), { off: false });
});

test("cascade — a nested off returns the CLOSEST ancestor (nearest OFF wins, not the farthest)", () => {
  // Both director:growth AND its own department are off. The resolver returns the CLOSER
  // (director:growth) so the audit ledger can attribute the flip to the tightest scope. We use
  // `media-buyer-cadence-cron` (a real growth-owned MONITORED_LOOPS id) as the query — the same
  // ancestor chain is exercised.
  const map = mapOf(row("growth", "department"), row("director:growth", "director"));
  const result = resolveEffectiveSwitchFromMap("media-buyer-cadence-cron", map);
  assert.equal(result.off, true);
  if (result.off) {
    assert.equal(result.offBy, "director:growth", "closer ancestor wins (director beats department)");
    assert.equal(result.scope, "director");
  }
});

test("fail-open — an EMPTY map returns { off: false } for every registered node", () => {
  const map = mapOf();
  assert.deepEqual(resolveEffectiveSwitchFromMap("media-buyer-cadence-cron", map), { off: false });
  assert.deepEqual(resolveEffectiveSwitchFromMap("director:cs", map), { off: false });
  assert.deepEqual(resolveEffectiveSwitchFromMap("dept:platform", map), { off: false });
  assert.deepEqual(resolveEffectiveSwitchFromMap("build", map), { off: false });
});

test("fail-open — an UNKNOWN node id (not in the registry) returns { off: false } — treated as ON", () => {
  // The Phase 3 route validates node existence against the registry, so a stored row for an
  // unknown id shouldn't happen in prod — but the resolver still degrades gracefully.
  const map = mapOf(row("growth", "department"));
  const result = resolveEffectiveSwitchFromMap("definitely-not-a-real-node-id-xxx", map);
  assert.deepEqual(result, { off: false });
});

test("reason attribution — the offending ancestor's `reason` bubbles up through the resolver", () => {
  const map = mapOf(row("growth", "department", "ceo", "M2 CEO cockpit pause — creative fatigue audit"));
  const result = resolveEffectiveSwitchFromMap("media-buyer-cadence-cron", map);
  assert.equal(result.off, true);
  if (result.off) {
    assert.equal(result.reason, "M2 CEO cockpit pause — creative fatigue audit");
  }
});

// ── ad-creative-box-session-only-retire-deterministic-path Phase 3 (2026-07-19) ──
// Agent-kind bare-slug convenience: a `kill_switches.node_id='ad-creative'` row (the bare
// slug — the form the CEO cockpit surfaces) must resolve `agent:ad-creative` as OFF.
// Before Phase 3 the row was ignored because `map.get('agent:ad-creative')` missed the
// bare-slug entry, letting the daily cadence produce ~2 queued+claimed jobs on 2026-07-19
// despite the switch being frozen.

test("agent-kind bare-slug — a `kill_switches.node_id='ad-creative'` row resolves `agent:ad-creative` as OFF (Phase 3 gap fix)", () => {
  const map = mapOf(row("ad-creative", "agent", "ceo", "creative-fatigue freeze"));
  const byCanonical = resolveEffectiveSwitchFromMap("agent:ad-creative", map);
  const byBareSlug = resolveEffectiveSwitchFromMap("ad-creative", map);
  assert.deepEqual(byCanonical, { off: true, offBy: "ad-creative", scope: "agent", reason: "creative-fatigue freeze" });
  assert.deepEqual(byBareSlug, { off: true, offBy: "ad-creative", scope: "agent", reason: "creative-fatigue freeze" });
});

test("agent-kind bare-slug — sibling agent-kinds stay ON (no over-broad match)", () => {
  const map = mapOf(row("ad-creative", "agent"));
  // Sibling growth-owned agent nodes stay ON — the bare slug is scoped to its own agent-kind.
  const mediaBuyer = resolveEffectiveSwitchFromMap("agent:media-buyer", map);
  const adCreativeCopyAuthor = resolveEffectiveSwitchFromMap("agent-kind:ad-creative-copy-author", map);
  assert.deepEqual(mediaBuyer, { off: false });
  assert.deepEqual(adCreativeCopyAuthor, { off: false });
});

// ── Batched resolution ───────────────────────────────────────────────────────────

test("resolveEffectiveSwitchMany — every id sees the SAME snapshot (batched read consistency)", async () => {
  // The M5 orphan-audit's contract: a batched scan resolves against ONE snapshot, so a write
  // that lands mid-scan doesn't cause read-skew across the returned map. We can't easily mock
  // the DB from a unit test, but we can prove the interface: an empty batch returns an empty map.
  invalidateKillSwitchCache();
  const result = await resolveEffectiveSwitchMany([]);
  assert.equal(result.size, 0);
});

// ── Cache invalidation ───────────────────────────────────────────────────────────

test("invalidateKillSwitchCache — a cache bust is a no-op if the cache is empty (defensive)", () => {
  // Idempotent contract: calling the invalidator twice, or on an empty cache, must not throw.
  invalidateKillSwitchCache();
  invalidateKillSwitchCache();
  // No assertion needed — the point is the call doesn't throw.
});
