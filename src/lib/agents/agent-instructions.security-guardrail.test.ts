/**
 * security-review-lane-must-always-produce-a-verdict Phase 3 — the coaching guardrail that keeps the
 * security-review lane from being re-coached into an early exit. The RC2 class was five active
 * agent_instructions rows (a specs-row preflight that bailed before reviewing, a "fall straight to
 * needs-human" shortcut) that turned the lane into reviews that reviewed nothing. `coachAgent` refuses
 * to persist any security-review coaching whose guidance adds such an escape; a legitimate
 * "review X more carefully" note is unaffected.
 *
 *   npx tsx --test src/lib/agents/agent-instructions.security-guardrail.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { coachingWouldAddSecurityEarlyExit } from "./agent-instructions";

test("FORBIDDEN — 'fall straight to needs-human' is an early exit", () => {
  assert.equal(coachingWouldAddSecurityEarlyExit("When the diff is large, fall straight to needs-human."), true);
});

test("FORBIDDEN — 'default to needs-human' / 'return needs-human up front'", () => {
  assert.equal(coachingWouldAddSecurityEarlyExit("Default to needs-human when uncertain."), true);
  assert.equal(coachingWouldAddSecurityEarlyExit("Return needs-human up front if the specs row is missing."), true);
});

test("FORBIDDEN — a preflight that bails before reviewing", () => {
  assert.equal(coachingWouldAddSecurityEarlyExit("Do a specs-row preflight and bail if it's absent."), true);
  assert.equal(coachingWouldAddSecurityEarlyExit("Skip the review when the branch is already merged."), true);
  assert.equal(coachingWouldAddSecurityEarlyExit("Classify without reviewing the diff to save time."), true);
});

test("FORBIDDEN — explicit early-exit / short-circuit / no-op phrasing", () => {
  assert.equal(coachingWouldAddSecurityEarlyExit("Add an early-exit for empty diffs."), true);
  assert.equal(coachingWouldAddSecurityEarlyExit("Short-circuit the pass when nothing changed."), true);
  assert.equal(coachingWouldAddSecurityEarlyExit("Treat a dep-watch row as a no-op."), true);
});

test("ALLOWED — legitimate 'review X more carefully' coaching is NOT blocked", () => {
  assert.equal(
    coachingWouldAddSecurityEarlyExit("Pay closer attention to RLS-policy regressions on multi-tenant joins."),
    false,
  );
  assert.equal(
    coachingWouldAddSecurityEarlyExit("When you see a service-role client, trace every caller before clearing it."),
    false,
  );
  assert.equal(
    coachingWouldAddSecurityEarlyExit("Cite file:line for each finding and never echo a secret value."),
    false,
  );
  // 'needs-human' mentioned as a legitimate terminal verdict (not an early-exit shortcut) is allowed.
  assert.equal(
    coachingWouldAddSecurityEarlyExit("A genuinely ambiguous authz change is a real needs-human verdict after you review it."),
    false,
  );
});
