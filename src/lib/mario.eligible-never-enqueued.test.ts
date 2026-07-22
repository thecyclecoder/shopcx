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
import {
  MARIO_BUILD_SCAN_IN_CHUNK,
  foldSlugsWithBuild,
  reclaimAndRedrive,
  shouldSurfaceEligibleNeverEnqueued,
} from "./mario";

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

// ── foldSlugsWithBuild — the chunked + fail-loud build-existence scan ────────
// Pins the two named failing states that motivate spec
// [[../specs/mario-eligible-never-enqueued-chunk-build-scan]]:
//   (1) an unchunked `.in()` blows past the PostgREST URL/param length ceiling and the errored
//       result was read as "no build exists" — every aged auto_build spec surfaced falsely,
//       burning a Mario Max session per aged spec per hour workspace-wide.
//   (2) the destructure `{ data: builds }` omitted `error`, so a genuine query error was
//       silently swallowed into an empty-set read — same false-positive detonation.

test("foldSlugsWithBuild — chunks a > 200-slug list into batches of ≤ MARIO_BUILD_SCAN_IN_CHUNK", async () => {
  const slugs = Array.from({ length: 450 }, (_, i) => `spec-${i}`);
  const batchSizes: number[] = [];
  await foldSlugsWithBuild(async (batch) => {
    batchSizes.push(batch.length);
    return { data: [], error: null };
  }, slugs);
  // 450 → 200 + 200 + 50; every batch must be ≤ MARIO_BUILD_SCAN_IN_CHUNK, never a single unchunked hit.
  assert.deepEqual(batchSizes, [MARIO_BUILD_SCAN_IN_CHUNK, MARIO_BUILD_SCAN_IN_CHUNK, 50]);
  for (const size of batchSizes) assert.ok(size <= MARIO_BUILD_SCAN_IN_CHUNK, `batch of ${size} exceeded chunk cap`);
});

test("foldSlugsWithBuild — a per-batch error THROWS (never silently treated as empty)", async () => {
  const slugs = Array.from({ length: 250 }, (_, i) => `spec-${i}`);
  let calls = 0;
  const boom = new Error("PostgREST URL too long");
  await assert.rejects(
    foldSlugsWithBuild(async () => {
      calls += 1;
      if (calls === 1) return { data: [{ spec_slug: "spec-0" }], error: null };
      return { data: null, error: boom };
    }, slugs),
    (err: unknown) => err === boom,
  );
});

test("foldSlugsWithBuild — merges results across batches into one set", async () => {
  const slugs = Array.from({ length: 300 }, (_, i) => `spec-${i}`);
  let calls = 0;
  const seen = await foldSlugsWithBuild(async (batch) => {
    calls += 1;
    // Return only the first slug in each batch — asserts every batch is scanned and merged.
    return { data: [{ spec_slug: batch[0] ?? null }], error: null };
  }, slugs);
  assert.equal(calls, 2); // 300 / 200 = 2 batches
  assert.deepEqual([...seen].sort(), ["spec-0", "spec-200"]);
});

test("foldSlugsWithBuild — empty slug list returns an empty set without hitting the scan callback", async () => {
  let calls = 0;
  const seen = await foldSlugsWithBuild(async () => {
    calls += 1;
    return { data: [], error: null };
  }, []);
  assert.equal(calls, 0);
  assert.equal(seen.size, 0);
});

test("foldSlugsWithBuild — drops null/empty spec_slug rows on the merge side", async () => {
  const seen = await foldSlugsWithBuild(
    async () => ({
      data: [{ spec_slug: null }, { spec_slug: "" }, { spec_slug: "real-spec" }],
      error: null,
    }),
    ["a"],
  );
  assert.deepEqual([...seen], ["real-spec"]);
});

test("Applier — `reclaim_and_redrive` verb is wired (reclaimAndRedrive is a function)", () => {
  // The verdict lane: this source flows into applyBoxMario's existing `reclaim_and_redrive`
  // switch case (mario.ts near the case "reclaim_and_redrive" block), which calls
  // `reclaimAndRedrive` → `queueRoadmapBuild`. The switch case pre-existed; this test pins
  // that the exported function is still available so the case wiring can never silently
  // decay under a rename without a compiler error here.
  assert.equal(typeof reclaimAndRedrive, "function");
});
