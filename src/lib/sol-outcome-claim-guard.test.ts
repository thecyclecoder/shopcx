/**
 * Unit tests for the Phase-3 send guard (docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md § Phase 3).
 *
 * Focus: the failing state from ticket 0a9e4d7f (Judy) — Sol's DRAFT reply
 * claimed "added a 2nd bag + applied $15 credit" while neither outcome had
 * verified in the DB. The Phase-3 invariant is:
 *   - `assessOutcomeClaims` is a pure regex-over-message-text predicate; a
 *     kind-specific claim phrase whose backing ticket_required_outcomes row is
 *     NOT status='verified' blocks the send.
 *   - A truthful reply that only states verified state (or explicitly names
 *     what's escalated) passes the guard cleanly.
 *   - Unknown kinds fail open (a null pattern set can't over-block a legitimate reply).
 *
 * Run: npx tsx --test src/lib/sol-outcome-claim-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TicketRequiredOutcome, RequiredOutcomeStatus } from "./ticket-required-outcomes";
import { assessOutcomeClaims, CLAIM_KIND_PATTERNS } from "./sol-outcome-claim-guard";

function fakeOutcome(overrides: Partial<TicketRequiredOutcome> & { status: RequiredOutcomeStatus }): TicketRequiredOutcome {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspace_id: "w",
    ticket_id: "t",
    direction_id: null,
    kind: "noop",
    description: "noop",
    target_ids: {},
    expected_db_state: {},
    resolution_event_id: null,
    verified_at: null,
    failed_reason: null,
    authored_by: "test",
    authored_at: new Date(0).toISOString(),
    ...overrides,
  };
}

// ── Judy's failing state (the named-failing-state test, learning #8) ────

test("Judy failing state: reply claims 'added 2nd bag + applied $15 credit' with BOTH outcomes UNVERIFIED → BLOCKED naming both claims", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "pending" }),
  ];
  const message =
    "Hi Judy, I've added a second bag of chocolate to your next order and applied a $15 credit as a courtesy. Enjoy!";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
  assert.equal((assessment as { blocked_claims: unknown[] }).blocked_claims.length, 2);
  const kinds = ((assessment as { blocked_claims: Array<{ kind: string }> }).blocked_claims)
    .map((b) => b.kind)
    .sort();
  assert.deepEqual(kinds, ["add_bag_to_next_order", "apply_coupon"]);
});

test("Judy — bag VERIFIED but credit PENDING → only credit blocked (partial verify)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "pending" }),
  ];
  const message =
    "Hi Judy, I've added a second bag of chocolate to your next order and applied a $15 credit as a courtesy. Enjoy!";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
  const claims = (assessment as { blocked_claims: Array<{ kind: string; description: string }> }).blocked_claims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "apply_coupon");
});

test("Judy — BOTH outcomes VERIFIED and reply claims both → OK (the truthful reply that passes)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "verified", verified_at: new Date().toISOString() }),
  ];
  const message =
    "Hi Judy, I've added a second bag of chocolate to your next order and applied a $15 credit as a courtesy. Enjoy!";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, true);
});

test("Truthful escalating reply naming what's ESCALATED (no false claims) → OK", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "failed", failed_reason: "coupon executor refused" }),
  ];
  const message =
    "Hi Judy, I've added a second bag to your next order. I wasn't able to apply the credit — I've flagged that for our team to review and reach out shortly. Sorry for the delay!";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, true, "the reply names the failed credit as escalated, doesn't claim it applied — passes");
});

// ── Predicate edge cases ────────────────────────────────────────────────

test("empty message → OK (nothing to assess)", () => {
  const assessment = assessOutcomeClaims({ message: "", outcomes: [fakeOutcome({ status: "pending", kind: "apply_coupon" })] });
  assert.equal(assessment.ok, true);
});

test("empty outcomes list → OK (no invariant to violate)", () => {
  const assessment = assessOutcomeClaims({ message: "Anything you want, we've applied a $100 credit!", outcomes: [] });
  assert.equal(assessment.ok, true);
});

test("unknown outcome kind (no pattern set) → SKIPPED (fail open — never over-block a legit reply)", () => {
  const outcomes = [fakeOutcome({ id: "x", kind: "some_novel_action_2027", description: "novel", status: "pending" })];
  const message = "Confirmed, all done.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, true);
});

test("only outcomes verified → any claim passes", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "cancel", description: "cancel next box", status: "verified", verified_at: new Date().toISOString() })];
  const message = "Your subscription is cancelled — no more boxes coming.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, true);
});

test("cancel + pause: message asserts pause but pause row unverified → BLOCKED with just the pause", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "cancel", description: "cancel", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "pause", description: "pause next box", status: "pending" }),
  ];
  const message = "I've paused your subscription for 30 days.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
  const claims = (assessment as { blocked_claims: Array<{ kind: string }> }).blocked_claims;
  assert.deepEqual(claims.map((c) => c.kind), ["pause"]);
});

test("Question form 'would you like me to add a bag?' does NOT match the claim pattern → OK", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "pending" })];
  const message = "Would you like me to add a second bag to your next order? Just say the word.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, true, "a QUESTION about the outcome is not a claim it's done");
});

test("Future-tense promise 'I'll add a second bag' → BLOCKED (a promise-to-do is still asserting the outcome will happen)", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "pending" })];
  const message = "No problem! I'll add a second bag to your next order right now.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
  const claims = (assessment as { blocked_claims: Array<{ kind: string }> }).blocked_claims;
  assert.deepEqual(claims.map((c) => c.kind), ["add_bag_to_next_order"]);
});

test("Refund claim 'issued a $25 refund' → matches partial_refund kind", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "partial_refund", description: "$25 refund on order X", status: "pending" })];
  const message = "I've issued a $25 refund — it'll show up in 3-5 business days.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
});

test("Replacement claim 'created a replacement' → matches create_replacement kind", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "create_replacement", description: "replacement for damaged order", status: "pending" })];
  const message = "Got it. I've created a replacement — you'll get a shipping notification shortly.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
});

test("Return claim 'here is your prepaid label' → matches create_return kind", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "create_return", description: "return for order X", status: "pending" })];
  const message = "Here is your prepaid return label — just drop the box at any USPS location.";
  const assessment = assessOutcomeClaims({ message, outcomes });
  assert.equal(assessment.ok, false);
});

// ── Public constant sanity ──────────────────────────────────────────────

test("CLAIM_KIND_PATTERNS: every entry has at least one RegExp (no empty pattern set can slip through)", () => {
  const kinds = Object.keys(CLAIM_KIND_PATTERNS);
  assert.ok(kinds.length > 0, "expected at least one seed kind");
  for (const k of kinds) {
    assert.ok(CLAIM_KIND_PATTERNS[k].length > 0, `${k} must have at least one regex — an empty array is a silent fail-open`);
  }
});

test("CLAIM_KIND_PATTERNS: seed set covers the four Judy-adjacent kinds", () => {
  const need = ["add_bag_to_next_order", "apply_coupon", "partial_refund", "create_replacement"];
  for (const k of need) {
    assert.ok(CLAIM_KIND_PATTERNS[k], `missing seed patterns for ${k}`);
  }
});
