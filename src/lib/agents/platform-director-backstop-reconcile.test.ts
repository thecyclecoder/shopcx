/**
 * escort-reliably-dispatches-ready-goal-members Phase 2 — pins the NAMED FAILING STATE for the backstop
 * reconcile sweep. `isReadyForBackstopQueue` is the pure predicate the async
 * [[../agents/platform-director]] `reconcileReadyGoalMembers` sweep applies to every approved-goal member
 * before it queues a build — a NO-DB-DEPENDENCY seam so the "ready-but-undispatched → queue exactly one"
 * decision is testable without a Supabase fixture.
 *
 * The three verification checkpoints from the spec's Phase 2 Verification section:
 *   1. Seeding a ready-but-undispatched approved-goal member → the sweep queues exactly one build.
 *   2. Running the sweep twice does NOT create a second build (idempotent — `inFlight` guard).
 *   3. A member with an uncleared blocker is NOT queued.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/agents/platform-director-backstop-reconcile.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isReadyForBackstopQueue,
  PLATFORM_DIRECTOR_LOOP_GUARD_MAX,
} from "./platform-director";
import type { SpecCard } from "../brain-roadmap";
import type { SpecBuildState } from "./platform-director";

// A minimal, spec-review-passed, unblocked, auto-build-eligible goal member card fixture. Each test
// mutates ONE dimension so the failing-state axis is unambiguous.
type ReadyCardShape = Pick<
  SpecCard,
  "slug" | "status" | "phases" | "shippedPr" | "valeReviewPassed" | "autoBuild" | "blockedBy"
>;

function readyMember(overrides: Partial<ReadyCardShape> = {}): ReadyCardShape {
  return {
    slug: "daily-cadence-cron",
    status: "planned",
    phases: [
      { title: "P1", status: "planned", pr: null, merge_sha: null, build_sha: null },
    ],
    shippedPr: null,
    valeReviewPassed: true,
    autoBuild: true,
    blockedBy: [],
    ...overrides,
  };
}

const notInFlight: Pick<SpecBuildState, "inFlight" | "failedCount"> = {
  inFlight: false,
  failedCount: 0,
};

test("Phase 2 verification #1: a ready-but-undispatched approved-goal member reads as READY — the backstop queues exactly one build", () => {
  const card = readyMember();
  assert.equal(
    isReadyForBackstopQueue(card, notInFlight),
    true,
    "the backstop MUST queue a build for a ready-but-undispatched member — this is the exact silent stall the sweep closes",
  );
});

test("Phase 2 verification #2: a member with an in-flight build is NOT queued — running the sweep twice must not create a second build", () => {
  const card = readyMember();
  // The first sweep queued the build → the second sweep sees an in-flight row and MUST skip. The
  // idempotency guarantee is at the `inFlight` seam — if this ever regresses, every standing pass would
  // stack a fresh duplicate build for the same spec.
  const inFlight: Pick<SpecBuildState, "inFlight" | "failedCount"> = { inFlight: true, failedCount: 0 };
  assert.equal(isReadyForBackstopQueue(card, inFlight), false);
});

test("Phase 2 verification #3: a member with an UNCLEARED blocker is NOT queued", () => {
  const card = readyMember({
    blockedBy: [
      { slug: "media-buyer-shadow-mode", title: "shadow-mode", status: "planned", cleared: false, kind: "spec" },
    ],
  });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), false);
});

test("Phase 2 verification #3 (variant): a member with MIXED blockers — one cleared, one uncleared — is NOT queued", () => {
  const card = readyMember({
    blockedBy: [
      { slug: "cleared-prereq", title: "cleared-prereq", status: "shipped", cleared: true, kind: "spec" },
      { slug: "still-blocking", title: "still-blocking", status: "planned", cleared: false, kind: "spec" },
    ],
  });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), false);
});

test("Phase 2 verification #3 (positive): a member with ALL blockers cleared IS queued", () => {
  const card = readyMember({
    blockedBy: [
      { slug: "shipped-prereq", title: "shipped-prereq", status: "shipped", cleared: true, kind: "spec" },
    ],
  });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional guards — the SAME set escortApprovedGoals applies. Every one is a "never queue" case
// the backstop MUST also respect so it never contradicts the primary escort's decisions.
// ─────────────────────────────────────────────────────────────────────────────

test("guard: an already-shipped spec is NOT queued", () => {
  // The rollup already marked it shipped — there's nothing to build. The backstop must NOT re-queue.
  const card = readyMember({
    status: "shipped",
    phases: [{ title: "P1", status: "shipped", pr: 42, merge_sha: "abc123", build_sha: null }],
  });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), false);
});

test("guard: a deferred spec (CEO parked it) is NOT queued", () => {
  const card = readyMember({ status: "deferred" });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), false);
});

test("retire-vale: an un-Vale-stamped spec IS queued — review is now a deterministic author-time gate", () => {
  // escort-retire-vale-eligibility-gate: `vale_review_passed_at` is retired and stamped by nothing, so a
  // ready goal member with no vale stamp must NOT be held (that dead gate is exactly what stalled the
  // escort + this backstop). A spec that exists as a row already passed the author-time gate → queueable.
  const card = readyMember({ valeReviewPassed: undefined });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), true);
});

test("guard: an auto-build opted-out spec is NOT queued", () => {
  const card = readyMember({ autoBuild: false });
  assert.equal(isReadyForBackstopQueue(card, notInFlight), false);
});

test("guard: a spec at the loop-guard cap is NOT queued — the primary escort's CEO escalation owns it, not a silent re-queue", () => {
  const card = readyMember();
  const atCap: Pick<SpecBuildState, "inFlight" | "failedCount"> = {
    inFlight: false,
    failedCount: PLATFORM_DIRECTOR_LOOP_GUARD_MAX,
  };
  assert.equal(isReadyForBackstopQueue(card, atCap), false);
});

test("guard: a spec ONE failure below the loop-guard cap (bounded retry) IS still queued — the backstop follows the same retry ceiling as escortApprovedGoals", () => {
  const card = readyMember();
  const belowCap: Pick<SpecBuildState, "inFlight" | "failedCount"> = {
    inFlight: false,
    failedCount: Math.max(0, PLATFORM_DIRECTOR_LOOP_GUARD_MAX - 1),
  };
  assert.equal(isReadyForBackstopQueue(card, belowCap), true);
});
