/**
 * Unit tests for the NINTH candidate source + `close_orphaned_pr` verb —
 * mario-detects-job-and-pr-wedges Phase 3. Pins the verification bullets from the spec:
 *
 *   (1) a fixture open PR whose spec is FOLDED is surfaced by `shouldSurfaceOrphanedFoldedPr`.
 *   (2) a PR whose spec is `planned`/`in_progress`/`in_review`/`deferred`/`null` is NOT surfaced.
 *   (3) a build job whose status is `merged` is NOT surfaced (PR already merged — nothing to close).
 *   (4) a shipped spec's open PR IS surfaced (equivalent to folded — the work is settled).
 *   (5) the `close_orphaned_pr` action string round-trips through `normalizeMarioVerdict` with
 *       target.spec_slug (real slug — the ninth source carries the real spec_slug, unlike the
 *       pr-resolve-storm source which uses a pseudo-slug).
 *
 * Pure predicate — no I/O, no DB. The applier's guard-before-mutation (re-read spec status right
 * before closing; refuse on any drift) is enforced inside `closeOrphanedPr` in mario.ts and is an
 * integration assertion (needs a live Supabase + GitHub API); the pin here is the DETECTION
 * predicate + normalizer surface — the runtime path lives above them.
 *
 * Run:
 *   npx tsx --test src/lib/mario.orphaned-folded-pr.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMarioVerdict, shouldSurfaceOrphanedFoldedPr } from "./mario";

// ── (1)–(4) shouldSurfaceOrphanedFoldedPr ────────────────────────────────

test("Bullet 1 — folded spec + non-merged build (needs_attention) → SURFACED", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "folded",
    buildJobStatus: "needs_attention",
  });
  assert.equal(surfaced, true);
});

test("Bullet 1 — folded spec + completed build (PR still open) → SURFACED", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "folded",
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, true);
});

test("Bullet 1 — folded spec + failed build → SURFACED", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "folded",
    buildJobStatus: "failed",
  });
  assert.equal(surfaced, true);
});

test("Bullet 2 — planned spec (live) → NOT surfaced (PR has a genuine reason to stay open)", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "planned",
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, false);
});

test("Bullet 2 — in_progress spec → NOT surfaced", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "in_progress",
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, false);
});

test("Bullet 2 — in_review spec (Vale-bounced) → NOT surfaced", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "in_review",
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, false);
});

test("Bullet 2 — deferred spec → NOT surfaced (a deferred spec's PR is a different lifecycle class)", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "deferred",
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, false);
});

test("Bullet 2 — status=null (no override, purely derived) → NOT surfaced", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: null,
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, false);
});

test("Bullet 3 — folded spec + MERGED build → NOT surfaced (PR already merged, nothing to close)", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "folded",
    buildJobStatus: "merged",
  });
  assert.equal(surfaced, false);
});

test("Bullet 4 — shipped spec + open PR → SURFACED (same class as folded — work is settled)", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "shipped",
    buildJobStatus: "completed",
  });
  assert.equal(surfaced, true);
});

test("Bullet 4 — shipped spec + MERGED build → NOT surfaced (belt-and-suspenders: merged wins the drop)", () => {
  const surfaced = shouldSurfaceOrphanedFoldedPr({
    specStatus: "shipped",
    buildJobStatus: "merged",
  });
  assert.equal(surfaced, false);
});

// ── (5) close_orphaned_pr verb round-trip ────────────────────────────────

test("Bullet 5 — close_orphaned_pr action round-trips through the normalizer with target.spec_slug", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "orphaned",
    live_fix: {
      action: "close_orphaned_pr",
      target: { spec_slug: "some-folded-spec", pr_number: 1893 },
      reasoning: "close the orphaned PR whose spec folded",
    },
  });
  assert.ok(v?.live_fix !== null);
  assert.equal(v?.live_fix?.action, "close_orphaned_pr");
  assert.equal(v?.live_fix?.target.spec_slug, "some-folded-spec");
  assert.equal(v?.live_fix?.target.pr_number, 1893);
});

test("Bullet 5 — close_orphaned_pr WITHOUT target.pr_number still round-trips (spec_slug is enough)", () => {
  // The applier re-derives pr_number from agent_jobs.spec_branch/pr_number, so the verdict shape
  // is minimal (spec_slug only). A verdict without pr_number is still well-formed.
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "orphaned",
    live_fix: {
      action: "close_orphaned_pr",
      target: { spec_slug: "some-folded-spec" },
      reasoning: "no pr_number needed",
    },
  });
  assert.ok(v?.live_fix !== null);
  assert.equal(v?.live_fix?.action, "close_orphaned_pr");
  assert.equal(v?.live_fix?.target.spec_slug, "some-folded-spec");
  assert.equal(v?.live_fix?.target.pr_number, undefined);
});
