/**
 * Unit test for fold-never-strands-a-shipped-spec-with-a-zero-machine-check-spec-test Phase 1 —
 * the pure predicate `isStrandedFoldCandidate` that decides whether a derived-shipped spec is
 * genuinely stranded outside `pending_folds` and should be enqueued via the fold-queue reaper's
 * stranded-fold backstop.
 *
 *   npx tsx --test scripts/builder-worker.stranded-fold.test.ts
 *
 * The named failing state we pin: a spec that (a) is derived-shipped, (b) has a merged build job,
 * (c) is security-clean, (d) has NO `pending_folds` row and NO live build/spec-test, MUST return
 * true — this is the exact class the primary auto-fold sweep drops (a clean 0-check spec-test run
 * is rejected by the [[isCleanMachinePassRun]] checks-length floor, so the spec never enters
 * pending_folds and strands forever). The other four negative gates each rehearse an invariant
 * the backstop deliberately preserves from the primary sweep.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isStrandedFoldCandidate } from "./builder-worker.stranded-fold";

const SLUG = "dahlia-researches-from-winners-flow-ad-library";

// A helper that builds the default-cleared state — all skip sets empty, everything green — so each
// test only overrides the ONE dimension it exercises.
function baseArgs(overrides?: Partial<Parameters<typeof isStrandedFoldCandidate>[0]>) {
  return {
    slug: SLUG,
    alreadyQueued: new Set<string>(),
    foldedSlugs: new Set<string>(),
    liveSlugs: new Set<string>(),
    mergedBuildSlugs: new Set<string>([SLUG]),
    securityClean: true,
    ...overrides,
  };
}

test("the 0-machine-check strand is recovered (Phase 1's named failing state)", () => {
  // The exact class the primary sweep drops: derived-shipped + merged build + security-clean +
  // NO pending_folds row + no live job. The backstop MUST enqueue it.
  assert.equal(isStrandedFoldCandidate(baseArgs()), true);
});

test("already-queued spec is skipped — the primary drainer owns it", () => {
  assert.equal(
    isStrandedFoldCandidate(baseArgs({ alreadyQueued: new Set([SLUG]) })),
    false,
  );
});

test("already-folded (lingering row) is skipped — nothing to enqueue", () => {
  assert.equal(
    isStrandedFoldCandidate(baseArgs({ foldedSlugs: new Set([SLUG]) })),
    false,
  );
});

test("a live build/spec-test job defers the fold — auto-fold would orphan the running build", () => {
  assert.equal(
    isStrandedFoldCandidate(baseArgs({ liveSlugs: new Set([SLUG]) })),
    false,
  );
});

test("no merged build job → skip — the code has not actually landed on main yet", () => {
  assert.equal(
    isStrandedFoldCandidate(baseArgs({ mergedBuildSlugs: new Set<string>() })),
    false,
  );
});

test("security not clean → skip — defer to the post-merge security review", () => {
  assert.equal(
    isStrandedFoldCandidate(baseArgs({ securityClean: false })),
    false,
  );
});

test("a SIBLING slug's queued/folded/live/build state does not block THIS slug", () => {
  const other = "some-other-spec";
  assert.equal(
    isStrandedFoldCandidate(
      baseArgs({
        alreadyQueued: new Set([other]),
        foldedSlugs: new Set([other]),
        liveSlugs: new Set([other]),
        mergedBuildSlugs: new Set([SLUG, other]),
      }),
    ),
    true,
  );
});
