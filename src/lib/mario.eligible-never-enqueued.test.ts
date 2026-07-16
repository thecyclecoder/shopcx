/**
 * Unit tests for the SIXTH candidate source — mario-detects-job-and-pr-wedges-not-just-spec-lifecycle
 * Phase 1. Pins the verification bullets from the spec:
 *
 *   (1) an eligible spec (auto_build=true, status planned/null, no build job, aged past grace)
 *       is SURFACED by the predicate → flows into `evaluateStalledSpecs`'s initial candidate set →
 *       the M4 agent's existing `reclaim_and_redrive` verb enqueues the missing build via
 *       `queueRoadmapBuild` (owner-gated, blocker-gated, active-build-gated).
 *   (2) an eligible spec WITH any build job (active or terminal) is NOT surfaced — the
 *       failed-build source owns that class, the never-enqueued source stays out of it.
 *   (3) `auto_build=false` is NOT surfaced — the source is scoped to autonomously-buildable
 *       specs; a spec awaiting human approval is a different lane.
 *   (4) status='folded' / 'deferred' / 'shipped' is NOT surfaced — a terminal override means
 *       no build should be enqueued.
 *   (5) age within the grace window is NOT surfaced — the roadmap enqueue path or a human
 *       authoring the spec should have room to land inside the grace.
 *
 * Pure predicate — no I/O, no DB. The applier side is a `reclaim_and_redrive` reuse (the case
 * already exists in `applyBoxMario` and is covered by inspection); this file pins the DETECTION
 * predicate that is the whole new-code delta.
 *
 * Run:
 *   npx tsx --test src/lib/mario.eligible-never-enqueued.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reclaimAndRedrive, shouldSurfaceEligibleNeverEnqueued } from "./mario";

const GRACE_MS = 60 * 60 * 1000;
const OVER_GRACE_MS = GRACE_MS + 1;
const UNDER_GRACE_MS = GRACE_MS - 1;

test("Bullet 1 — planned+auto_build+no-build-job aged past grace → SURFACED", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "planned",
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, true);
});

test("Bullet 1 — status=null (no explicit override) + auto_build + no-build-job past grace → SURFACED", () => {
  // Stored `specs.status` is override-only — a spec never explicitly flipped is null, not 'planned'.
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: null,
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, true);
});

test("Bullet 2 — spec WITH any build job is NOT surfaced (failed-build source owns it)", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "planned",
    autoBuild: true,
    hasAnyBuildJob: true, // any build row on this slug → never-enqueued is FALSE by definition
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Bullet 3 — auto_build=false is NOT surfaced (source scoped to autonomously-buildable specs)", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "planned",
    autoBuild: false,
    hasAnyBuildJob: false,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Bullet 4 — status='folded' is NOT surfaced", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "folded",
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Bullet 4 — status='deferred' is NOT surfaced", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "deferred",
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Bullet 4 — status='shipped' is NOT surfaced (terminal — no build to enqueue)", () => {
  // A shipped spec with no build row is a data-drift edge case, not a stall — never enqueue.
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "shipped",
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: OVER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Bullet 5 — age within grace window is NOT surfaced (roadmap enqueue still has room)", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "planned",
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: UNDER_GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Bullet 5 — age EQUAL to grace (boundary) is NOT surfaced (strict >, not >=)", () => {
  const surfaced = shouldSurfaceEligibleNeverEnqueued({
    status: "planned",
    autoBuild: true,
    hasAnyBuildJob: false,
    ageMs: GRACE_MS,
    graceMs: GRACE_MS,
  });
  assert.equal(surfaced, false);
});

test("Applier — `reclaim_and_redrive` verb is wired (reclaimAndRedrive is a function)", () => {
  // The verdict lane: this source flows into applyBoxMario's existing `reclaim_and_redrive`
  // switch case (mario.ts near the case "reclaim_and_redrive" block), which calls
  // `reclaimAndRedrive` → `queueRoadmapBuild`. The switch case pre-existed; this test pins
  // that the exported function is still available so the case wiring can never silently
  // decay under a rename without a compiler error here.
  assert.equal(typeof reclaimAndRedrive, "function");
});
