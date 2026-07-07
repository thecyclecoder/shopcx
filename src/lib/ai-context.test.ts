/**
 * Unit tests for the ESTABLISHED PROBLEM prompt line composed by
 * establishedProblemPromptLine — the Phase-1 verification of
 * docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md pins
 * the exact string, so we pin it here too. Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/ai-context.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { establishedProblemPromptLine } from "./ai-context";

test("T1 refund_request → the exact spec-verification string is emitted", () => {
  const line = establishedProblemPromptLine({ turn: 1, problem: "refund_request" });
  assert.equal(
    line,
    "ESTABLISHED PROBLEM (locked in at T1): refund_request. Any pivot MUST be justified explicitly in reasoning.",
  );
});

test("later-turn lock-in stamps its own turn index", () => {
  const line = establishedProblemPromptLine({ turn: 3, problem: "subscription_pause" });
  assert.match(line, /^ESTABLISHED PROBLEM \(locked in at T3\): subscription_pause\./);
});
