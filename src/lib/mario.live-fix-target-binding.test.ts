/**
 * Unit tests for the Phase-4 security binding — mario-detects-job-and-pr-wedges Phase 4 fix.
 * The two new live-fix verbs (`cancel_pr_resolve_storm` from Phase 2 + `close_orphaned_pr` from
 * Phase 3) must bind their target to the DETERMINISTIC context on the Mario job row BEFORE any
 * DB or GitHub mutation, so an injected verdict cannot retarget the mutation to a sibling PR /
 * sibling folded spec in the same workspace.
 *
 * Pins the exact security contract of the two pure scope predicates:
 *
 *   (A) checkCancelPrResolveStormScope
 *     A1. valid pseudo-slug + matching verdict.target.pr_number → OK; returns the surfaced pr.
 *     A2. mismatch verdict.pr_number vs job pseudo-slug → REJECTED (`pr_number_mismatch:` reason).
 *     A3. missing verdict.pr_number → REJECTED (`target_pr_number_missing`).
 *     A4. non-pseudo-slug job (e.g. a real spec slug on a mis-routed verdict) → REJECTED.
 *     A5. malformed pseudo-slug (`pr-abc`, `pr-`, `pr--5`) → REJECTED.
 *
 *   (B) checkCloseOrphanedPrScope
 *     B1. verdict target.spec_slug === job spec_slug → OK; returns the canonical (job) slug.
 *     B2. verdict target.spec_slug !== job spec_slug → REJECTED (`spec_slug_mismatch:` reason).
 *     B3. verdict target.spec_slug omitted → OK using job spec_slug (implicit binding).
 *
 *   (C) parsePrResolvePseudoSlug boundary tests.
 *
 * Pure predicate — no I/O. Run:
 *   npx tsx --test src/lib/mario.live-fix-target-binding.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCancelPrResolveStormScope,
  checkCloseOrphanedPrScope,
  parsePrResolvePseudoSlug,
} from "./mario";

// ── (A) checkCancelPrResolveStormScope ─────────────────────────────────────

test("A1 — valid pseudo-slug + matching pr_number → OK, surfaced pr returned", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr-1893",
    target: { pr_number: 1893 },
  });
  assert.equal(scope.ok, true);
  if (scope.ok) assert.equal(scope.prNumber, 1893);
});

test("A2 — verdict.pr_number differs from job pseudo-slug → REJECTED (pr_number_mismatch)", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr-1893",
    target: { pr_number: 999 }, // an injected verdict targeting a sibling PR
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^pr_number_mismatch: job=1893 verdict=999$/);
});

test("A2 — an off-by-one attack is REJECTED (1893 vs 1894 not equal)", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr-1893",
    target: { pr_number: 1894 },
  });
  assert.equal(scope.ok, false);
});

test("A3 — missing verdict.pr_number → REJECTED (target_pr_number_missing)", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr-1893",
    target: {}, // no pr_number in the target at all
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.equal(scope.reason, "target_pr_number_missing");
});

test("A4 — a mis-routed verdict on a REAL spec slug (not `pr-<n>`) → REJECTED", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "some-real-spec",
    target: { pr_number: 1893 },
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^job_spec_slug_not_pseudo_pr: some-real-spec$/);
});

test("A5 — malformed pseudo-slug `pr-abc` → REJECTED as not-pseudo-pr", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr-abc",
    target: { pr_number: 1893 },
  });
  assert.equal(scope.ok, false);
});

test("A5 — pseudo-slug with negative number `pr--5` → REJECTED", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr--5",
    target: { pr_number: 1893 },
  });
  assert.equal(scope.ok, false);
});

test("A5 — bare `pr-` (empty number) → REJECTED", () => {
  const scope = checkCancelPrResolveStormScope({
    jobSpecSlug: "pr-",
    target: { pr_number: 1893 },
  });
  assert.equal(scope.ok, false);
});

// ── (B) checkCloseOrphanedPrScope ──────────────────────────────────────────

test("B1 — verdict.spec_slug matches job slug → OK, canonical (job) slug returned", () => {
  const scope = checkCloseOrphanedPrScope({
    jobSpecSlug: "some-folded-spec",
    target: { spec_slug: "some-folded-spec" },
  });
  assert.equal(scope.ok, true);
  if (scope.ok) assert.equal(scope.specSlug, "some-folded-spec");
});

test("B2 — verdict.spec_slug differs from job slug → REJECTED (spec_slug_mismatch)", () => {
  const scope = checkCloseOrphanedPrScope({
    jobSpecSlug: "some-folded-spec",
    target: { spec_slug: "some-OTHER-folded-spec" }, // injected verdict retargeting a sibling
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^spec_slug_mismatch: job=some-folded-spec verdict=some-OTHER-folded-spec$/);
});

test("B3 — verdict.spec_slug omitted → OK using job spec_slug (implicit binding is safe)", () => {
  const scope = checkCloseOrphanedPrScope({
    jobSpecSlug: "some-folded-spec",
    target: {}, // no spec_slug in the target
  });
  assert.equal(scope.ok, true);
  if (scope.ok) assert.equal(scope.specSlug, "some-folded-spec");
});

test("B3 — verdict.spec_slug + verdict.pr_number both omitted → OK (implicit binding)", () => {
  const scope = checkCloseOrphanedPrScope({
    jobSpecSlug: "some-folded-spec",
    target: {},
  });
  assert.equal(scope.ok, true);
});

// ── (C) parsePrResolvePseudoSlug ────────────────────────────────────────────

test("C — parses `pr-42` to 42", () => {
  assert.equal(parsePrResolvePseudoSlug("pr-42"), 42);
});

test("C — parses `pr-1` to 1 (boundary: PR #1 is valid)", () => {
  assert.equal(parsePrResolvePseudoSlug("pr-1"), 1);
});

test("C — a real slug (no pr- prefix) parses to null", () => {
  assert.equal(parsePrResolvePseudoSlug("some-real-spec"), null);
});

test("C — `pr-abc` parses to null", () => {
  assert.equal(parsePrResolvePseudoSlug("pr-abc"), null);
});

test("C — `pr-` parses to null (empty number)", () => {
  assert.equal(parsePrResolvePseudoSlug("pr-"), null);
});

test("C — `pr-0` parses to null (PR #0 does not exist)", () => {
  assert.equal(parsePrResolvePseudoSlug("pr-0"), null);
});

test("C — `pr--5` parses to null (negative)", () => {
  assert.equal(parsePrResolvePseudoSlug("pr--5"), null);
});

test("C — `pr-42-suffix` parses to null (extra suffix)", () => {
  // Must be a bare `pr-<digits>$` — a `pr-42-extra` shape is a real spec whose slug happens to
  // start with `pr-`, not the pseudo-slug.
  assert.equal(parsePrResolvePseudoSlug("pr-42-suffix"), null);
});
