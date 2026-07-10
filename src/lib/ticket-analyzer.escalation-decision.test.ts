/**
 * Unit tests for `decideEscalationAction` — the pure predicate at the heart of
 * `escalation-keys-on-real-severity-not-a-middling-score-minor-issue-on-resolved-ticket-stays-closed`
 * Phase 2. The trigger keys on severity / actionability, NOT a raw middling
 * score. A resolved ticket with only a minor quality note is neither
 * reopened nor escalated (no cs-director-call); a ticket with a severe
 * issue class or an unresolved customer still auto-escalates.
 *
 * Built-in node:test — run:
 *   npx tsx --test src/lib/ticket-analyzer.escalation-decision.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideEscalationAction } from "./ticket-analyzer";

// A base input every test can spread from — nothing severe, no threat, ticket
// is cleanly positively closed, mid-range score. The Phase 2 case.
const RESOLVED_MINOR_BASE = {
  score: 5,
  hasSevereIssue: false,
  customerThreat: false,
  positivelyClosed: true,
  forceEscalate: false,
} as const;

test("Phase 2 core: resolved ticket + only a minor issue + score 5 → NOT reopened, NOT escalated", () => {
  const { action, reason } = decideEscalationAction({ ...RESOLVED_MINOR_BASE });
  assert.equal(action, "none");
  assert.match(reason, /resolved|positively closed|not actionable|coaching/i);
});

test("resolved + no severe + no threat + score 3 (would have been an ≤5 auto-escalate) → still 'none'", () => {
  const { action } = decideEscalationAction({ ...RESOLVED_MINOR_BASE, score: 3 });
  assert.equal(
    action,
    "none",
    "a low raw score alone on a resolved, non-severe, non-threat ticket must NOT reopen — Phase 2 keys on severity/actionability, not the score number",
  );
});

test("resolved + no severe + no threat + score 6 (existing silent-reopen tier) → still 'none'", () => {
  const { action } = decideEscalationAction({ ...RESOLVED_MINOR_BASE, score: 6 });
  assert.equal(action, "none");
});

test("SEVERE issue class → escalate_silent even on a positively closed ticket (severity trumps resolution)", () => {
  const { action } = decideEscalationAction({
    ...RESOLVED_MINOR_BASE,
    score: 3,
    hasSevereIssue: true,
    forceEscalate: true,
  });
  assert.equal(action, "escalate_silent");
});

test("customer-threat keyword → escalate_silent even on a positively closed ticket (actionable customer situation)", () => {
  const { action } = decideEscalationAction({
    ...RESOLVED_MINOR_BASE,
    score: 8,
    customerThreat: true,
    forceEscalate: true,
  });
  assert.equal(action, "escalate_silent");
});

test("UNRESOLVED customer + score ≤5 → escalate_with_message (actionable customer, low-quality handling)", () => {
  const { action } = decideEscalationAction({
    ...RESOLVED_MINOR_BASE,
    score: 4,
    positivelyClosed: false,
  });
  assert.equal(action, "escalate_with_message");
});

test("UNRESOLVED customer + score 6 → escalate_silent (existing tier for unresolved handling)", () => {
  const { action } = decideEscalationAction({
    ...RESOLVED_MINOR_BASE,
    score: 6,
    positivelyClosed: false,
  });
  assert.equal(action, "escalate_silent");
});

test("UNRESOLVED customer + score 8 + no forceEscalate → 'none' (existing behavior — a good-score unresolved is fine)", () => {
  const { action } = decideEscalationAction({
    ...RESOLVED_MINOR_BASE,
    score: 8,
    positivelyClosed: false,
  });
  assert.equal(action, "none");
});

test("resolved + score 8 + no severe + no threat → 'none' (unchanged baseline)", () => {
  const { action } = decideEscalationAction({ ...RESOLVED_MINOR_BASE, score: 8 });
  assert.equal(action, "none");
});

test("forceEscalate=true always wins over the resolved-minor gate (severe/threat path already computed)", () => {
  const { action } = decideEscalationAction({
    ...RESOLVED_MINOR_BASE,
    score: 8,
    forceEscalate: true,
  });
  assert.equal(action, "escalate_silent");
});

test("reason string names 'severity or actionability' when the resolved-minor gate suppresses escalation", () => {
  const { reason } = decideEscalationAction({ ...RESOLVED_MINOR_BASE, score: 4 });
  assert.match(
    reason,
    /severity|actionab/i,
    "the audit reason must name the severity/actionability contract",
  );
});

// ── Terminal-state override: mid-turn wrongness is coaching, not escalation ──
// Kim SC134360 / b7921d19: score 4 driven entirely by two turn-1 broken_action
// issues (malformed return + leaked {{label_url}} token), but the $133.80 refund
// executed and the ticket closed resolved. resolvedByAction must beat the
// severe-issue force-escalate so a well-resolved ticket is not re-opened.
test("resolvedByAction beats a severe-issue force-escalate (Kim: turn-1 broken_actions recovered by the refund) → 'none'", () => {
  const { action, reason } = decideEscalationAction({
    score: 4,
    hasSevereIssue: true,
    customerThreat: false,
    positivelyClosed: false, // closed via the SDK after a founder-directed refund — no AI positive-close note
    forceEscalate: true,     // severe issue would normally force silent escalation
    resolvedByAction: true,
  });
  assert.equal(action, "none");
  assert.match(reason, /terminal|resolved by a verified action|END state|mid-turn/i);
});

test("resolvedByAction does NOT suppress a customer threat — threat still escalates", () => {
  const { action } = decideEscalationAction({
    score: 4,
    hasSevereIssue: true,
    customerThreat: true,
    positivelyClosed: false,
    forceEscalate: true,
    resolvedByAction: true,
  });
  assert.equal(action, "escalate_silent", "a chargeback/BBB/lawyer threat at the terminal state still escalates even if an action resolved the substantive ask");
});

test("no resolvedByAction: a severe issue on a non-positively-closed ticket still force-escalates (baseline unchanged)", () => {
  const { action } = decideEscalationAction({
    score: 4,
    hasSevereIssue: true,
    customerThreat: false,
    positivelyClosed: false,
    forceEscalate: true,
    resolvedByAction: false,
  });
  assert.equal(action, "escalate_silent");
});

test("resolvedByAction omitted (undefined) is treated as false — existing callers unaffected", () => {
  const { action } = decideEscalationAction({
    score: 4,
    hasSevereIssue: true,
    customerThreat: false,
    positivelyClosed: false,
    forceEscalate: true,
  });
  assert.equal(action, "escalate_silent");
});
