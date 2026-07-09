/**
 * Unit tests for detectInflection — Phase 1 of
 * docs/brain/specs/sol-drift-frustration-detector-and-re-session-router.md.
 *
 * The spec pins four behaviors:
 *   - pure-frustration cue → 'frustration' (no Haiku call)
 *   - drift keywords (multi-signal) → 'drift'   (no Haiku call)
 *   - benign message → 'none'                    (no Haiku call)
 *   - ambiguous single-signal drift → Haiku called, its verdict respected
 * Plus one guardrail from the spec text:
 *   - frustration always wins over drift when both fire
 *
 * Pure helper — no network, no DB. The Haiku transport is injected so the assertions can
 * pin whether Stage 2 was reached. Run:
 *   npx tsx --test src/lib/inflection-detector.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectInflection,
  type DetectInflectionInput,
  type HaikuVerdict,
} from "./inflection-detector";

function baseInput(overrides: Partial<DetectInflectionInput> = {}): DetectInflectionInput {
  return {
    direction: {
      intent: "refund shipping delay lost package tracking",
      authored_at: "2026-07-01T00:00:00Z",
    },
    newestMessage: "thanks for the tracking update, appreciate it",
    recentTurns: [
      { reasoning: "asked for tracking; customer replied with order number" },
      { reasoning: "acknowledged shipping delay and shared tracking" },
    ],
    turnIndex: 2,
    aiTurnLimit: 6,
    isPlaybookActive: false,
    playbookExceptionsIncrementedSinceDirection: false,
    ...overrides,
  };
}

test("pure-frustration cue → 'frustration' and Haiku is NEVER called", async () => {
  let called = 0;
  const result = await detectInflection(
    baseInput({
      newestMessage: "this is ridiculous, refund me now",
      haiku: async () => {
        called++;
        return { kind: "none", reason: "should not be called" };
      },
    }),
  );
  assert.equal(result.kind, "frustration", "hard frustration cue must classify frustration");
  assert.equal(called, 0, "Stage 2 must not run on a definite Stage 1 outcome");
  assert.equal(result.evidence.stage, 1);
  assert.ok(result.evidence.cues && result.evidence.cues.length > 0, "cues must be recorded");
});

test("multi-signal drift → 'drift' and Haiku is NEVER called", async () => {
  let called = 0;
  const result = await detectInflection(
    baseInput({
      // topic pivot — no intent tokens survive; and we're already at turn_index >= 0.8 * ai_turn_limit.
      newestMessage: "actually can you change my flavor to strawberry",
      recentTurns: [{ reasoning: "asked about tracking earlier" }],
      turnIndex: 5,
      aiTurnLimit: 6,
      playbookExceptionsIncrementedSinceDirection: true,
      haiku: async () => {
        called++;
        return { kind: "none", reason: "should not be called" };
      },
    }),
  );
  assert.equal(result.kind, "drift", "≥2 drift signals must classify drift");
  assert.equal(called, 0, "Stage 2 must not run on a definite Stage 1 outcome");
  assert.equal(result.evidence.stage, 1);
});

test("benign message → 'none' and Haiku is NEVER called", async () => {
  let called = 0;
  const result = await detectInflection(
    baseInput({
      newestMessage: "thanks for the tracking update, appreciate the fast shipping refund handling",
      haiku: async () => {
        called++;
        return { kind: "drift", reason: "should not be called" };
      },
    }),
  );
  assert.equal(result.kind, "none", "a benign in-intent message must classify none");
  assert.equal(called, 0, "Stage 2 must not run on Stage 1 'none'");
});

test("ambiguous single-signal drift → Haiku IS called and its verdict is respected", async () => {
  let called = 0;
  let seenIntent = "";
  const haiku = async (args: {
    intent: string;
    newestMessage: string;
  }): Promise<HaikuVerdict | null> => {
    called++;
    seenIntent = args.intent;
    return { kind: "drift", reason: "topic pivoted to flavor swap" };
  };
  const result = await detectInflection(
    baseInput({
      newestMessage: "can you swap my flavor",
      recentTurns: [{ reasoning: "resolving shipping delay" }],
      // one drift signal only: turn approach ratio (5/6 >= 0.8), NOT keyword drift (short msg)
      turnIndex: 5,
      aiTurnLimit: 6,
      playbookExceptionsIncrementedSinceDirection: false,
      haiku,
    }),
  );
  assert.equal(called, 1, "a single drift signal must escalate to Stage 2 exactly once");
  assert.equal(result.kind, "drift", "Haiku's verdict must be honored");
  assert.equal(result.evidence.stage, 2);
  assert.match(result.evidence.reason, /^haiku:/, "reason must reflect Haiku origin");
  assert.equal(seenIntent, "refund shipping delay lost package tracking");
});

test("frustration wins over drift when BOTH fire (spec: highest-value trigger)", async () => {
  let called = 0;
  const result = await detectInflection(
    baseInput({
      // A frustration cue in a topic-pivot message that would also register as drift.
      newestMessage: "refund me now, cancel everything, this is ridiculous",
      recentTurns: [{ reasoning: "resolving shipping delay" }],
      turnIndex: 5,
      aiTurnLimit: 6,
      playbookExceptionsIncrementedSinceDirection: true,
      haiku: async () => {
        called++;
        return { kind: "drift", reason: "should not be called" };
      },
    }),
  );
  assert.equal(result.kind, "frustration", "frustration must outrank drift on the tie");
  assert.equal(called, 0, "no Haiku call — Stage 1 frustration is definite");
});

test("playbook-active ticket: frustration still fires (mid-playbook refund_now bounces)", async () => {
  const result = await detectInflection(
    baseInput({
      isPlaybookActive: true,
      newestMessage: "refund me now",
    }),
  );
  assert.equal(result.kind, "frustration", "frustration must fire even mid-playbook");
});

test("playbook-active ticket: drift path is SKIPPED (spec: not meaningful mid-playbook)", async () => {
  let called = 0;
  const result = await detectInflection(
    baseInput({
      isPlaybookActive: true,
      // Would otherwise register drift: full topic pivot + turn approach + exception increment.
      newestMessage: "actually change my flavor to strawberry please",
      turnIndex: 5,
      aiTurnLimit: 6,
      playbookExceptionsIncrementedSinceDirection: true,
      haiku: async () => {
        called++;
        return { kind: "drift", reason: "should not be called" };
      },
    }),
  );
  assert.equal(result.kind, "none", "mid-playbook drift path must be skipped");
  assert.equal(called, 0, "Stage 2 must not run when Stage 1 is skipped to none");
  assert.equal(result.evidence.reason, "playbook_active_skip_drift");
});

test("Haiku transient failure on 'maybe' falls back to 'none' (do not bounce on ambiguity)", async () => {
  const result = await detectInflection(
    baseInput({
      newestMessage: "can you swap my flavor",
      turnIndex: 5,
      aiTurnLimit: 6,
      haiku: async () => null,
    }),
  );
  assert.equal(result.kind, "none", "a Haiku failure on 'maybe' must not fabricate a bounce");
  assert.equal(result.evidence.stage, 2);
  assert.equal(result.evidence.reason, "haiku_unavailable_fallback_none");
});
