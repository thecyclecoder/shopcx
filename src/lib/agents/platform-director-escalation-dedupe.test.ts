/**
 * one-open-escalation-per-thing Phase 1 — pins the NAMED FAILING STATE for the escalation-card mint.
 *
 * The 2026-07-28 320k-card storm proved a duplicate-open card is a real, unbounded failure mode. The
 * fix is a state, not an event: one open dedupe_key = one open card. `decideEscalationMint` is the
 * pure fork the emitter runs after touching the OPEN card — it decides insert / bumped / loop-detected
 * from the (bumped, ceilingHit, seenCount, firstSeenIso) shape `bumpOpenEscalationCard` returns. Kept
 * pure so the invariant is unit-testable without a Supabase seam.
 *
 * The three checkpoints the spec's Phase 1 Verification implies:
 *   1. No OPEN card exists → action='insert' (mint a fresh one).
 *   2. OPEN card exists and the counter is under the hourly ceiling → action='bumped' (touch, don't insert).
 *   3. OPEN card exists and the mint rate has crossed the hourly ceiling → action='loop_detected' (safety
 *      valve — emit ONE 'escalation loop detected' card instead of touching the original further).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agents/platform-director-escalation-dedupe.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideEscalationMint, ESCALATION_MINT_CEILING_PER_HOUR } from "./platform-director";

const NOW_MS = Date.parse("2026-07-28T12:00:00Z");

test("decideEscalationMint — no OPEN card → action='insert' (the first mint of a fresh condition)", () => {
  const decision = decideEscalationMint(
    { bumped: false, ceilingHit: false, seenCount: 0, firstSeenIso: null, cardId: null },
    NOW_MS,
  );
  assert.equal(decision.action, "insert", "with no OPEN card the emitter must fall through to insert");
});

test("decideEscalationMint — OPEN card touched in-place → action='bumped' (the state-not-event contract)", () => {
  const decision = decideEscalationMint(
    { bumped: true, ceilingHit: false, seenCount: 5, firstSeenIso: new Date(NOW_MS - 10 * 60 * 1000).toISOString(), cardId: "c-1" },
    NOW_MS,
  );
  assert.equal(decision.action, "bumped", "a successful bump must NOT trigger a fresh insert");
  if (decision.action === "bumped") {
    assert.equal(decision.seenCount, 5, "seenCount reflects the bumped value the caller can carry into logs");
  }
});

test("decideEscalationMint — mint rate crossed the hourly ceiling → action='loop_detected' (the safety valve)", () => {
  const firstSeenIso = new Date(NOW_MS - 30 * 60 * 1000).toISOString(); // 30 min ago
  const decision = decideEscalationMint(
    { bumped: false, ceilingHit: true, seenCount: ESCALATION_MINT_CEILING_PER_HOUR, firstSeenIso, cardId: "c-2" },
    NOW_MS,
  );
  assert.equal(decision.action, "loop_detected", "past the ceiling the safety valve must fire (one loop card, not more bumps)");
  if (decision.action === "loop_detected") {
    assert.equal(decision.originalCount, ESCALATION_MINT_CEILING_PER_HOUR, "originalCount is what the caller shows on the loop card");
    assert.ok(decision.windowMs > 0, "windowMs is a positive elapsed time since first_seen_at");
    assert.ok(decision.windowMs < 60 * 60 * 1000, "windowMs stays within the counting window (≤1h since first_seen)");
  }
});

test("decideEscalationMint — ceilingHit with no firstSeenIso → action='loop_detected' falls back to a 1h window", () => {
  // Defensive path: a hiccup on the metadata read could return ceilingHit=true without a firstSeen
  // timestamp. The helper must still return a well-formed loop_detected decision (windowMs=ONE_HOUR_MS)
  // so the loop-card body has a sensible rate to quote — never NaN, never negative.
  const decision = decideEscalationMint(
    { bumped: false, ceilingHit: true, seenCount: 200, firstSeenIso: null, cardId: "c-3" },
    NOW_MS,
  );
  assert.equal(decision.action, "loop_detected");
  if (decision.action === "loop_detected") {
    assert.equal(decision.windowMs, 60 * 60 * 1000, "missing firstSeenIso defaults the window to 1h");
    assert.equal(decision.originalCount, 200);
  }
});
