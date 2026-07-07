/**
 * Unit tests for the merge-summary Phase-1 predicate + prompt builder in
 * src/lib/ticket-merge.ts. Pure helpers — no network, no DB. Run:
 *   npx tsx --test src/lib/ticket-merge.test.ts
 *
 * Named failing state (spec Phase-1 verification): "does not re-summarize
 * unchanged history on a later unrelated update." The predicate must return
 * false when a prior summary exists AND this merge event moved zero
 * messages — otherwise every unrelated merge-touch would burn another
 * Sonnet call on the same content.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldRegenerateMergeSummary, buildMergeSummaryPrompt } from "./ticket-merge";

test("first merge (no prior summary) → regenerate = true", () => {
  assert.equal(shouldRegenerateMergeSummary(null, 12), true);
  assert.equal(shouldRegenerateMergeSummary(null, 0), true);
});

test("repeat merge with newly-moved messages → regenerate = true", () => {
  assert.equal(shouldRegenerateMergeSummary("prior state", 3), true);
});

test("repeat merge with zero newly-moved messages → regenerate = false (named failing state)", () => {
  assert.equal(
    shouldRegenerateMergeSummary("customer wanted refund; issued $42", 0),
    false,
    "prior summary + 0 new messages must NOT re-cost Sonnet on unchanged history",
  );
});

test("first-merge prompt has no PRIOR STATE header + includes messages", () => {
  const { system, user } = buildMergeSummaryPrompt(null, [
    { direction: "inbound", author_type: "customer", visibility: "public", body: "hi", created_at: "2026-07-07T00:00:00Z" },
  ]);
  assert.match(system, /support-ticket state summarizer/);
  assert.doesNotMatch(user, /PRIOR STATE/);
  assert.match(user, /MERGED CONVERSATION/);
  assert.match(user, /\[customer\/inbound\] hi/);
});

test("repeat-merge prompt carries prior state forward + only newly-merged messages", () => {
  const { user } = buildMergeSummaryPrompt("prior: address = Kirkland; refund pending", [
    { direction: "inbound", author_type: "customer", visibility: "public", body: "one more thing", created_at: "2026-07-07T00:00:00Z" },
  ]);
  assert.match(user, /PRIOR STATE/);
  assert.match(user, /address = Kirkland/);
  assert.match(user, /NEWLY MERGED MESSAGES/);
  assert.match(user, /one more thing/);
});

test("summary tags internal-visibility messages so state can't miss agent-side context", () => {
  const { user } = buildMergeSummaryPrompt(null, [
    { direction: "outbound", author_type: "agent", visibility: "internal", body: "flagged as chargeback risk", created_at: "2026-07-07T00:00:00Z" },
  ]);
  assert.match(user, /\[agent\/outbound \(internal\)\] flagged as chargeback risk/);
});
