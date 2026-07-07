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
import { pickModelFromSignals } from "./model-picker";

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
