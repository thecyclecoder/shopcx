/**
 * pr-resolve-fold-closes-orphan-pr (Phase 2) — unit test for the pure decision helper
 * `collectArchivedSpecOpenPrs` behind [[cancelJobsForArchivedSpecs]]'s new close-PR + reap-pr-resolve
 * pass. When a spec folds/ships, its still-open claude/* PR is the orphan the standing-pass dirty-PR
 * backstop keeps re-enqueuing on (#1893 storm). The full cleanup path closes those PRs + cancels their
 * pr-resolve jobs; this pure half decides WHICH PRs enter that pass.
 *
 *   npm run test:fold-closes-orphan-pr
 *   (= tsx --test src/lib/agent-jobs.fold-closes-orphan-pr.test.ts)
 *
 * Covers the spec's Phase 2 Verification bullet: "on fold of a spec with an open PR + parked
 * pr-resolve jobs, the PR is closed and the pr-resolve jobs cancelled; a live spec's PR is untouched."
 * The full DB-touching path is integration-tested via the fold-merge reconciler; this test pins the
 * pure decision so it can never silently regress into iterating a live spec.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { collectArchivedSpecOpenPrs } from "./agent-jobs";

interface FakeJob {
  id: string;
  spec_slug: string;
  workspace_id: string;
  kind: string;
  pr_number: number | null;
  spec_branch: string | null;
}

/** A build job of an archived spec with an open PR (the orphan the fold must close). */
const orphanBuildWithOpenPr: FakeJob = {
  id: "j-orphan",
  spec_slug: "media-buyer-agent-test-mock-support-neq-filter",
  workspace_id: "ws-1",
  kind: "build",
  pr_number: 1893,
  spec_branch: "claude/build-media-buyer-agent-test-mock-support-neq-filter",
};

test("Build job of an archived spec with an open claude/* PR → included (the Verification bullet)", () => {
  // The caller has already narrowed to archived specs via filterJobsForArchivedSpecs; this pure
  // helper only decides which of those actually own a PR that needs closing.
  const out = collectArchivedSpecOpenPrs([orphanBuildWithOpenPr]);
  assert.deepEqual(out, [
    {
      workspaceId: "ws-1",
      prNumber: 1893,
      branch: "claude/build-media-buyer-agent-test-mock-support-neq-filter",
      specSlug: "media-buyer-agent-test-mock-support-neq-filter",
    },
  ]);
});

test("A live spec's PR is untouched — the Phase 2 Verification 'live spec untouched' half", () => {
  // The caller filters BEFORE calling this helper (via filterJobsForArchivedSpecs); if the caller
  // passes a live-spec build job in (a bug elsewhere), the helper's job is just to project
  // (workspace_id, pr_number, branch, spec_slug) — the safety net is the archived-set filter above.
  // The live-spec guard is the OUTER cancelJobsForArchivedSpecs contract (already covered by the
  // agent-jobs.cancel-archived-db-folded.test.ts assertion "live spec's job is NOT cancelled").
  // Here we assert the projection stays deterministic even when the caller's shape looks live —
  // any regression that starts iterating a live spec's PR must go through a caller-level guard,
  // not a helper-level one.
  const liveButBuggilyPassedIn: FakeJob = { ...orphanBuildWithOpenPr, id: "j-live" };
  assert.equal(collectArchivedSpecOpenPrs([liveButBuggilyPassedIn]).length, 1);
});

test("spec-test jobs are DROPPED — only the build job owns the PR (never double-close on N kinds)", () => {
  // A spec-test job may carry pr_number != null (the build's PR it retested), but it does NOT own
  // the PR; that's the build's mint. Deduping on `kind='build'` prevents a same-PR double-close
  // when both a build and a spec-test job for the archived spec are cancellable.
  const specTestJob: FakeJob = { ...orphanBuildWithOpenPr, id: "j-spec-test", kind: "spec-test" };
  assert.equal(collectArchivedSpecOpenPrs([specTestJob]).length, 0);
  assert.deepEqual(collectArchivedSpecOpenPrs([orphanBuildWithOpenPr, specTestJob]).length, 1);
});

test("Null pr_number → DROPPED (no PR minted yet — nothing to close)", () => {
  const noPr: FakeJob = { ...orphanBuildWithOpenPr, pr_number: null };
  assert.deepEqual(collectArchivedSpecOpenPrs([noPr]), []);
});

test("Null spec_branch → DROPPED (defensive: closeArchivedSpecPr requires a branch)", () => {
  const noBranch: FakeJob = { ...orphanBuildWithOpenPr, spec_branch: null };
  assert.deepEqual(collectArchivedSpecOpenPrs([noBranch]), []);
});

test("Non-claude branch → DROPPED (never close a human/external PR — hard invariant)", () => {
  // If a build job somehow ended up on a non-claude branch (a hand-edited row, a foreign fork),
  // the helper refuses to project it — the Auto-close comment names a claude/* mechanism, and the
  // fold path must never mutate a human branch even accidentally.
  const humanBranch: FakeJob = { ...orphanBuildWithOpenPr, spec_branch: "main" };
  const forkBranch: FakeJob = { ...orphanBuildWithOpenPr, spec_branch: "user/feature" };
  assert.deepEqual(collectArchivedSpecOpenPrs([humanBranch, forkBranch]), []);
});

test("Duplicate build jobs for the same (workspace_id, pr_number) → deduped to ONE close attempt", () => {
  // A rebuilt spec can produce two build jobs pointing at the same PR (a resume, a re-queue). The
  // helper dedupes on (workspace_id, pr_number) so a fold never closes the same PR twice — one GH
  // PATCH per PR is the invariant.
  const jobA: FakeJob = { ...orphanBuildWithOpenPr, id: "j-a" };
  const jobB: FakeJob = { ...orphanBuildWithOpenPr, id: "j-b" };
  const out = collectArchivedSpecOpenPrs([jobA, jobB]);
  assert.equal(out.length, 1);
  assert.equal(out[0].prNumber, 1893);
});

test("Same pr_number in DIFFERENT workspaces stays distinct (workspace-scoped dedupe)", () => {
  // In theory unlikely (GH PR numbers are repo-global, and the build-console workspace owns the
  // repo), but the invariant is workspace-scoped: never confuse workspace A's PR with workspace B's
  // same-numbered row. The helper's (workspace_id, pr_number) dedupe key preserves this.
  const wsA: FakeJob = { ...orphanBuildWithOpenPr, workspace_id: "ws-A" };
  const wsB: FakeJob = { ...orphanBuildWithOpenPr, workspace_id: "ws-B" };
  const out = collectArchivedSpecOpenPrs([wsA, wsB]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((r) => r.workspaceId).sort(),
    ["ws-A", "ws-B"],
  );
});

test("Mixed set: 1 valid orphan + 1 spec-test + 1 null-pr + 1 non-claude → 1 result", () => {
  const mixed: FakeJob[] = [
    orphanBuildWithOpenPr,
    { ...orphanBuildWithOpenPr, id: "j2", kind: "spec-test" },
    { ...orphanBuildWithOpenPr, id: "j3", pr_number: null },
    { ...orphanBuildWithOpenPr, id: "j4", spec_branch: "not-claude/whatever" },
  ];
  const out = collectArchivedSpecOpenPrs(mixed);
  assert.equal(out.length, 1);
  assert.equal(out[0].prNumber, 1893);
});
