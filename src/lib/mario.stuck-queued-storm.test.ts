/**
 * Unit tests for the Phase-2 job/PR-scoped detectors — mario-detects-job-and-pr-wedges Phase 2:
 *   (1) stuck-queued-build lane wedge — `shouldSurfaceStuckQueuedBuild` (source a7).
 *   (2) pr-resolve storm — `shouldSurfacePrResolveStorm` (source a8).
 *   (3) MarioLiveFix.target.pr_number — normalizer accepts a positive integer, rejects garbage
 *       (so the applier's `.eq('pr_number', …)` compare-and-set is never fed a stray string).
 *   (4) `cancel_pr_resolve_storm` verb is wired (the exported normalizer surfaces it end-to-end).
 *
 * The !specRow relax at (d0) is unit-testable end-to-end only against a stubbed Supabase; this
 * file pins the SEAM the relax consumes (a from_event in `JOB_PR_SCOPED_FROM_EVENTS` — a candidate
 * is a job/PR wedge, not a spec-lifecycle phantom). The from_event strings the sources emit are
 * asserted by construction in evaluateStalledSpecs (a7/a8 blocks); a regression there would break
 * the survivor invariant covered here.
 *
 * Pure predicates — no I/O, no DB. Run:
 *   npx tsx --test src/lib/mario.stuck-queued-storm.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMarioVerdict,
  shouldSurfacePrResolveStorm,
  shouldSurfaceStuckQueuedBuild,
} from "./mario";

const GRACE_MS = 45 * 60 * 1000;
const OVER_GRACE_MS = GRACE_MS + 1;
const UNDER_GRACE_MS = GRACE_MS - 1;

// ── (1) shouldSurfaceStuckQueuedBuild ─────────────────────────────────────

test("Stuck-queued Bullet 1 — status=queued + claimed_at null + past grace → SURFACED", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "queued",
    claimedAt: null,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, true);
});

test("Stuck-queued Bullet 2 — a build that WAS claimed (claimed_at set) is NOT surfaced", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "queued",
    claimedAt: "2026-07-15T00:00:00.000Z", // was claimed once → different class (redrive_dropped_job / unstick)
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Stuck-queued Bullet 3 — a mid-flight build (status='building') is NOT surfaced (redrive owns it)", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "building",
    claimedAt: null,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Stuck-queued Bullet 3 — a claimed row (status='claimed') is NOT surfaced (unstick owns it)", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "claimed",
    claimedAt: null,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Stuck-queued Bullet 3 — a failed build is NOT surfaced (failed-build source owns it)", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "failed",
    claimedAt: null,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Stuck-queued Bullet 4 — within grace → NOT surfaced (a fresh queue is normal, not a wedge)", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "queued",
    claimedAt: null,
    ageMs: UNDER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Stuck-queued Bullet 4 — age EQUAL to grace (boundary) → NOT surfaced (strict >)", () => {
  const surfaced = shouldSurfaceStuckQueuedBuild({
    status: "queued",
    claimedAt: null,
    ageMs: GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

// ── (2) shouldSurfacePrResolveStorm ───────────────────────────────────────

test("Storm Bullet 1 — parkedCount ≥ min → SURFACED (3 parked at min=3)", () => {
  const surfaced = shouldSurfacePrResolveStorm({ parkedCount: 3, minCount: 3 });
  assert.equal(surfaced, true);
});

test("Storm Bullet 1 — parkedCount far above min (2026-07-15: 61 parked overnight) → SURFACED", () => {
  const surfaced = shouldSurfacePrResolveStorm({ parkedCount: 61, minCount: 3 });
  assert.equal(surfaced, true);
});

test("Storm Bullet 2 — parkedCount below min → NOT surfaced (just a normal retry, not a storm)", () => {
  const surfaced = shouldSurfacePrResolveStorm({ parkedCount: 2, minCount: 3 });
  assert.equal(surfaced, false);
});

test("Storm Bullet 2 — parkedCount 0 → NOT surfaced (no rows at all)", () => {
  const surfaced = shouldSurfacePrResolveStorm({ parkedCount: 0, minCount: 3 });
  assert.equal(surfaced, false);
});

// ── (3) MarioLiveFix.target.pr_number normalizer ──────────────────────────

test("pr_number Bullet 1 — normalizer accepts a positive integer verbatim", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "storming",
    live_fix: {
      action: "cancel_pr_resolve_storm",
      target: { pr_number: 1893 },
      reasoning: "cancel the parked pile",
    },
  });
  assert.ok(v?.live_fix !== null);
  assert.equal(v?.live_fix?.action, "cancel_pr_resolve_storm");
  assert.equal(v?.live_fix?.target.pr_number, 1893);
});

test("pr_number Bullet 2 — normalizer REJECTS a stringy pr_number (avoids feeding SQL a stray string)", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "malformed",
    live_fix: {
      action: "cancel_pr_resolve_storm",
      target: { pr_number: "1893" as unknown as number },
      reasoning: "bad type",
    },
  });
  // live_fix passes (has an action), but pr_number is stripped so the applier throws instead of running SQL.
  assert.ok(v?.live_fix !== null);
  assert.equal(v?.live_fix?.target.pr_number, undefined);
});

test("pr_number Bullet 3 — normalizer REJECTS a negative pr_number", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "malformed",
    live_fix: {
      action: "cancel_pr_resolve_storm",
      target: { pr_number: -5 },
      reasoning: "bad sign",
    },
  });
  assert.equal(v?.live_fix?.target.pr_number, undefined);
});

test("pr_number Bullet 3 — normalizer REJECTS a non-integer pr_number", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "malformed",
    live_fix: {
      action: "cancel_pr_resolve_storm",
      target: { pr_number: 1893.5 },
      reasoning: "fractional",
    },
  });
  assert.equal(v?.live_fix?.target.pr_number, undefined);
});

test("pr_number Bullet 3 — normalizer REJECTS pr_number=0 (no PR is #0)", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "malformed",
    live_fix: {
      action: "cancel_pr_resolve_storm",
      target: { pr_number: 0 },
      reasoning: "zero is not a PR",
    },
  });
  assert.equal(v?.live_fix?.target.pr_number, undefined);
});

// ── (4) verb-wiring sanity ────────────────────────────────────────────────

test("Verb — cancel_pr_resolve_storm action string round-trips through the normalizer", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "storm",
    live_fix: {
      action: "cancel_pr_resolve_storm",
      target: { pr_number: 42 },
      reasoning: "cancel it",
    },
  });
  assert.equal(v?.live_fix?.action, "cancel_pr_resolve_storm");
  assert.equal(v?.live_fix?.target.pr_number, 42);
});
