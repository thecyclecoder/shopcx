/**
 * Pins the Phase 2 invariant of
 * docs/brain/specs/cora-grades-against-ai-data-surface-no-false-fabrication-on-unseen-facts.md:
 * an `unverified_from_surface` note (a Phase 1 grader tag for a claim the
 * grader could not verify from its own context) NEVER triggers escalation
 * on its own. Concretely — when the analyzer's issues array is non-empty
 * but every entry is typed `unverified_from_surface`, the sole-flag
 * predicate must return true; the `applySeverityActions` gate reads this
 * predicate to short-circuit the escalate path on a positively-closed
 * ticket, so the cs-director-call cron never enqueues a June review for
 * a resolved ticket whose only flag is "I couldn't verify this from my
 * surface." A genuine surface-contradicting `inaccuracy`, a
 * `false_promise`, a `broken_action`, or any mixed set (unverified +
 * anything else) must still register as NOT-sole-unverified so the
 * existing severe-issue / force-escalate path fires exactly as before.
 *
 * Run:
 *   npx tsx --test src/lib/ticket-analyzer.sole-unverified-escalation.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  UNVERIFIED_FROM_SURFACE_ISSUE_TYPE,
  analysisIssuesAreSoleUnverifiedFromSurface,
} from "./ticket-analyzer";

test("sole unverified flag → predicate true (Phase 2: does not trigger escalation on its own)", () => {
  const issues = [
    {
      type: UNVERIFIED_FROM_SURFACE_ISSUE_TYPE,
      description: "AI said 'Vanilla' variant — order line variant name is not in the surface",
    },
  ];
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface(issues),
    true,
    "an issues array whose only entry is unverified_from_surface must be flagged as sole-unverified",
  );
});

test("empty issues → predicate false (no flag at all is not the sole-unverified case)", () => {
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface([]),
    false,
    "empty issues is not the pattern this predicate guards — must return false so the caller does not short-circuit",
  );
});

test("real surface-contradicting inaccuracy → predicate false (escalates as before)", () => {
  const issues = [
    {
      type: "inaccuracy",
      description: "AI said per-unit was $30 but the surface shows the customer was charged $25/unit",
    },
  ];
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface(issues),
    false,
    "a genuine inaccuracy must NOT be treated as sole-unverified — the escalation path stays intact",
  );
});

test("mixed unverified + inaccuracy → predicate false (real inaccuracy still escalates)", () => {
  const issues = [
    { type: UNVERIFIED_FROM_SURFACE_ISSUE_TYPE, description: "flavor claim unverified" },
    { type: "inaccuracy", description: "per-unit total does not reconcile — surface-contradicting" },
  ];
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface(issues),
    false,
    "any non-unverified issue in the set must flip the predicate to false so the escalate path fires",
  );
});

test("mixed unverified + robotic → predicate false (non-severe non-unverified still counts)", () => {
  const issues = [
    { type: UNVERIFIED_FROM_SURFACE_ISSUE_TYPE, description: "variant claim unverified" },
    { type: "robotic", description: "boilerplate closing" },
  ];
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface(issues),
    false,
    "the predicate must not care whether the OTHER issue is severe — only sole-unverified suppresses escalation",
  );
});

test("multiple unverified issues (still sole type) → predicate true", () => {
  const issues = [
    { type: UNVERIFIED_FROM_SURFACE_ISSUE_TYPE, description: "flavor unverified" },
    { type: UNVERIFIED_FROM_SURFACE_ISSUE_TYPE, description: "shipping window unverified" },
  ];
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface(issues),
    true,
    "two unverified issues + zero other types is still 'sole unverified' — the whole flag set is unverified",
  );
});

test("false_promise → predicate false (broken-promise force-escalate stays intact)", () => {
  const issues = [
    { type: "false_promise", description: "promised refund with no matching refund action" },
  ];
  assert.equal(
    analysisIssuesAreSoleUnverifiedFromSurface(issues),
    false,
    "a false_promise is severe and must never be classified as sole-unverified — Phase 2 does not touch this path",
  );
});
