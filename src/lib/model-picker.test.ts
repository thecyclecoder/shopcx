/**
 * Unit tests for pickModelFromSignals — the pure decision core of
 * pickOrchestratorModel. Phase 1 verification of
 * docs/brain/specs/model-picker-routes-on-state-not-tags-ltv-stops-buying-opus.md
 * pins: LTV alone no longer trips Opus (the 142-ticket blind Sonnet replay
 * found 78% of Opus tickets downgrade-safe within 1 grade pt; LTV was not
 * the axis that correlated with the genuinely-hard buckets). Pure helper —
 * no network, no DB. Run:
 *   npx tsx --test src/lib/model-picker.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickModelFromSignals, type ModelSignals } from "./model-picker";
import type { TicketDirection } from "./ticket-directions";

test("no Opus signals → sonnet (LTV alone must NOT push Opus)", () => {
  const pick = pickModelFromSignals({
    aiTurnCount: 0,
    tags: [],
    crisisCount: 0,
    linksCount: 0,
    activeSubsCount: 1,
    recentMergesCount: 0,
  });
  assert.equal(pick.model, "sonnet");
  assert.equal(pick.reason, "default");
});

test("turn 1+ still trips Opus (spec: turn 1 didn't close the ticket)", () => {
  const pick = pickModelFromSignals({
    aiTurnCount: 2,
    tags: [],
    crisisCount: 0,
    linksCount: 0,
    activeSubsCount: 0,
    recentMergesCount: 0,
  });
  assert.equal(pick.model, "opus");
  assert.match(pick.reason, /^turn>=2/);
});

test("crisis-enrollment still trips Opus (genuinely-hard bucket per replay)", () => {
  const pick = pickModelFromSignals({
    aiTurnCount: 0,
    tags: [],
    crisisCount: 1,
    linksCount: 0,
    activeSubsCount: 0,
    recentMergesCount: 0,
  });
  assert.equal(pick.model, "opus");
  assert.match(pick.reason, /crisis-enrollment/);
});

test("linked-accounts still trips Opus (genuinely-hard bucket per replay)", () => {
  const pick = pickModelFromSignals({
    aiTurnCount: 0,
    tags: [],
    crisisCount: 0,
    linksCount: 1,
    activeSubsCount: 0,
    recentMergesCount: 0,
  });
  assert.equal(pick.model, "opus");
  assert.match(pick.reason, /linked-accounts/);
});

test("complex tag prefixes (crisis, pb:, j:cancel, fraud) still trip Opus in Phase 1", () => {
  for (const t of ["crisis", "pb:refund", "j:cancel:hard", "fraud"]) {
    const pick = pickModelFromSignals({
      aiTurnCount: 0,
      tags: [t],
      crisisCount: 0,
      linksCount: 0,
      activeSubsCount: 0,
      recentMergesCount: 0,
    });
    assert.equal(pick.model, "opus", `tag=${t} must still trip Opus in Phase 1`);
  }
});

test("active subs >= 2 still trips Opus", () => {
  const pick = pickModelFromSignals({
    aiTurnCount: 0,
    tags: [],
    crisisCount: 0,
    linksCount: 0,
    activeSubsCount: 3,
    recentMergesCount: 0,
  });
  assert.equal(pick.model, "opus");
  assert.match(pick.reason, /active-subs=3/);
});

test("recently-merged still trips Opus", () => {
  const pick = pickModelFromSignals({
    aiTurnCount: 0,
    tags: [],
    crisisCount: 0,
    linksCount: 0,
    activeSubsCount: 0,
    recentMergesCount: 1,
  });
  assert.equal(pick.model, "opus");
  assert.match(pick.reason, /recently-merged/);
});

test("reason string never contains ltv=$… (Phase 1: LTV token removed from ai_token_usage.purpose)", () => {
  // Even under an all-signals-firing composite reason, no ltv token can slip in.
  const pick = pickModelFromSignals({
    aiTurnCount: 5,
    tags: ["crisis"],
    crisisCount: 1,
    linksCount: 1,
    activeSubsCount: 2,
    recentMergesCount: 1,
  });
  assert.equal(pick.model, "opus");
  assert.doesNotMatch(pick.reason, /ltv=/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 (M2 sol-cheap-execution-over-ticket-direction) — Direction-driven Haiku route.
// Verifications from the spec:
//   1. Direction stateless authored 1h ago + confidence=0.9 + threshold=0.7 → Haiku.
//   2. Same shape with confidence=0.5 → Sonnet (fresh Direction not enough alone).
//   3. Direction authored 30h ago (window=24h) → Sonnet (freshness gate failed).
// The migration for sol_haiku_freshness_hours ships in the same PR as this suite; the
// column-exists bullet is verified by supabase/migrations/*_ai_channel_config_sol_haiku_freshness_hours.sql.
// ─────────────────────────────────────────────────────────────────────────────

function directionAuthoredHoursAgo(nowMs: number, ageHours: number, overrides: Partial<TicketDirection> = {}): TicketDirection {
  return {
    id: "dir-1",
    workspace_id: "ws-1",
    ticket_id: "tkt-1",
    intent: "customer wants a refund",
    context_summary: "VIP, damaged item",
    chosen_path: "stateless",
    plan: {},
    guardrails: {},
    authored_by: "sol_box_session",
    authored_at: new Date(nowMs - ageHours * 3600 * 1000).toISOString(),
    superseded_at: null,
    resession_count: 0,
    ...overrides,
  };
}

function noOpusSignals(overrides: Partial<ModelSignals> = {}): ModelSignals {
  return {
    aiTurnCount: 0,
    tags: [],
    crisisCount: 0,
    linksCount: 0,
    activeSubsCount: 0,
    recentMergesCount: 0,
    ...overrides,
  };
}

test("Phase 3 v1: fresh (1h ago) stateless Direction + confidence=0.9 >= threshold=0.7 → Haiku", () => {
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const pick = pickModelFromSignals(noOpusSignals({
    direction: directionAuthoredHoursAgo(nowMs, 1),
    latestConfidence: 0.9,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
    nowMs,
  }));
  assert.equal(pick.model, "haiku");
  assert.match(pick.reason, /^sol-direction-fresh\(/);
  assert.match(pick.reason, /conf=0\.90/);
});

test("Phase 3 v2: fresh Direction but confidence=0.5 < threshold=0.7 → Sonnet (not Haiku)", () => {
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const pick = pickModelFromSignals(noOpusSignals({
    direction: directionAuthoredHoursAgo(nowMs, 1),
    latestConfidence: 0.5,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
    nowMs,
  }));
  assert.equal(pick.model, "sonnet");
  assert.equal(pick.reason, "default");
});

test("Phase 3 v3: stale Direction (30h ago, window=24h) → Sonnet (freshness gate fails)", () => {
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const pick = pickModelFromSignals(noOpusSignals({
    direction: directionAuthoredHoursAgo(nowMs, 30),
    latestConfidence: 0.9,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
    nowMs,
  }));
  assert.equal(pick.model, "sonnet");
  assert.equal(pick.reason, "default");
});

test("Phase 3: superseded Direction → Sonnet (superseded_at NOT NULL disables route)", () => {
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const dir = directionAuthoredHoursAgo(nowMs, 1, { superseded_at: new Date(nowMs - 10 * 60 * 1000).toISOString() });
  const pick = pickModelFromSignals(noOpusSignals({
    direction: dir,
    latestConfidence: 0.9,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
    nowMs,
  }));
  assert.equal(pick.model, "sonnet");
});

test("Phase 3: Direction chosen_path='playbook' → Sonnet (route is stateless-only)", () => {
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const pick = pickModelFromSignals(noOpusSignals({
    direction: directionAuthoredHoursAgo(nowMs, 1, { chosen_path: "playbook" }),
    latestConfidence: 0.9,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
    nowMs,
  }));
  assert.equal(pick.model, "sonnet");
});

test("Phase 3: sol_haiku_freshness_hours=null → Sonnet (route disabled per-channel)", () => {
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const pick = pickModelFromSignals(noOpusSignals({
    direction: directionAuthoredHoursAgo(nowMs, 1),
    latestConfidence: 0.9,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: null,
    nowMs,
  }));
  assert.equal(pick.model, "sonnet");
});

test("Phase 3: Opus signal beats a fresh Direction (turn>=1 → Opus, not Haiku)", () => {
  // A genuinely-hard ticket still pays for reliability — the Haiku route can only
  // relax the picker from Sonnet → Haiku, never overrule a genuine Opus signal.
  const nowMs = Date.parse("2026-07-07T12:00:00Z");
  const pick = pickModelFromSignals({
    aiTurnCount: 2,
    tags: [],
    crisisCount: 0,
    linksCount: 0,
    activeSubsCount: 0,
    recentMergesCount: 0,
    direction: directionAuthoredHoursAgo(nowMs, 1),
    latestConfidence: 0.95,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
    nowMs,
  });
  assert.equal(pick.model, "opus");
  assert.match(pick.reason, /^turn>=2/);
});

test("Phase 3: no Direction (Sol hasn't authored) → Sonnet default preserved", () => {
  const pick = pickModelFromSignals(noOpusSignals({
    direction: null,
    latestConfidence: 0.9,
    problemLockinThreshold: 0.7,
    solHaikuFreshnessHours: 24,
  }));
  assert.equal(pick.model, "sonnet");
  assert.equal(pick.reason, "default");
});
