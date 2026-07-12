/**
 * builder-self-heals-stale-build-branch Phase 1 — reconciliation strategy tests.
 *
 * Pins the NAMED failing state from 2026-07-11: a goal-member build branch (director-chat-in-
 * leash-execution, machine-declared-verification-and-deterministic-spec-test-runner) inherits
 * merge commits from the goal branch's reconciliation with main, and `git rebase origin/main`
 * spuriously conflicts on every retry while `git merge origin/main` applies CLEAN — the loop
 * guard escalated the same self-healable staleness twice to the CEO inbox.  The primary
 * predicate MUST pick MERGE for a non-linear branch, and the fallback MUST recreate-fresh only
 * when no built work is at risk.
 *
 * Pure — no I/O.  Run:
 *   npx tsx --test src/lib/build-lane-reconcile.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseReconcile,
  chooseReconcileFallback,
  extractConflictingFiles,
  formatReconcileConflictError,
  type ReconcileInput,
} from "./build-lane-reconcile";

const base: ReconcileInput = {
  headContainsMain: false,
  hasMergeCommits: false,
  hasBuiltWork: false,
  branchOnRemote: false,
};

test("HEAD already contains main → skip (nothing to reconcile)", () => {
  assert.equal(chooseReconcile({ ...base, headContainsMain: true }), "skip");
});

test("non-linear branch (merge commits since divergence) → merge (primary — rebase would spuriously conflict)", () => {
  // The 2026-07-11 director-chat / ceo-org-control-tower shape: goal-member branch inherits
  // merge commits from the goal branch's main reconciliation.  A `git rebase origin/main`
  // replays the merges and hits the SAME conflict every retry (that is what escalated to the
  // CEO twice).  A `git merge origin/main` applies CLEAN.  Primary MUST be MERGE.
  assert.equal(chooseReconcile({ ...base, hasMergeCommits: true }), "merge");
});

test("truly-linear branch (no merge commits) → rebase (primary — clean linear replay)", () => {
  // A one-off spec's first phase, cut off main with a single linear commit ahead.  Rebase is
  // safe and produces the cleanest history.
  assert.equal(chooseReconcile({ ...base, hasMergeCommits: false }), "rebase");
});

test("goal-member branch with built work AND merge commits → merge (never rewrite BUILT commits)", () => {
  // A member branch with a merge from goal + a built phase on top.  Primary MERGE keeps every
  // built commit's SHA intact so downstream stampPhaseBuilt's `build_sha` stays valid.
  assert.equal(
    chooseReconcile({
      ...base,
      hasMergeCommits: true,
      hasBuiltWork: true,
      branchOnRemote: true,
    }),
    "merge",
  );
});

test("fallback: primary merge conflicted, branch has built work → rebase (never recreate)", () => {
  // Invariant: hasBuiltWork gates recreate-fresh OFF.  A built phase's commit is durable state
  // the fallback must never drop, so flip to the OTHER reconcile approach (rebase).
  assert.equal(
    chooseReconcileFallback({
      ...base,
      hasMergeCommits: true,
      hasBuiltWork: true,
      branchOnRemote: true,
    }),
    "rebase",
  );
});

test("fallback: primary rebase conflicted, box-local branch with NO built work → recreate-fresh", () => {
  // The director-chat-in-leash-execution case named in the spec: box-local branch, zero built
  // work, human could not reset it remotely.  Its commits are throwaway attempts from an
  // earlier failed session — safe to reset onto the correct base.
  assert.equal(
    chooseReconcileFallback({
      ...base,
      hasMergeCommits: false,
      hasBuiltWork: false,
      branchOnRemote: false,
    }),
    "recreate-fresh",
  );
});

test("fallback: primary rebase conflicted, NO built work but PUSHED to origin → merge (preserve remote history)", () => {
  // On-origin branch: recreating fresh would rewrite the remote → forbidden.  Fall back to
  // merge instead (which never rewrites the branch).
  assert.equal(
    chooseReconcileFallback({
      ...base,
      hasMergeCommits: false,
      hasBuiltWork: false,
      branchOnRemote: true,
    }),
    "merge",
  );
});

test("fallback: primary merge conflicted, built work exists → NEVER recreate-fresh (invariant)", () => {
  // Belt-and-suspenders: with any built work at all, the fallback must NOT be recreate-fresh.
  // No configuration of the other flags can override this.
  for (const branchOnRemote of [true, false]) {
    for (const hasMergeCommits of [true, false]) {
      const r = chooseReconcileFallback({
        ...base,
        hasBuiltWork: true,
        hasMergeCommits,
        branchOnRemote,
      });
      assert.notEqual(r, "recreate-fresh", `hasBuiltWork=true must forbid recreate-fresh (branchOnRemote=${branchOnRemote}, hasMergeCommits=${hasMergeCommits})`);
    }
  }
});

test("fallback: headContainsMain → skip (defensive; caller should not invoke fallback in this state)", () => {
  // A wrong fallback call when nothing needed reconciling is a no-op, not a wrong action.
  assert.equal(
    chooseReconcileFallback({ ...base, headContainsMain: true }),
    "skip",
  );
});

// ── Phase 2 — name the conflicting files on the real-conflict park ──────────────────────────────

test("extractConflictingFiles: content-merge conflict on one file", () => {
  const out = [
    "Auto-merging src/lib/foo.ts",
    "CONFLICT (content): Merge conflict in src/lib/foo.ts",
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n");
  assert.deepEqual(extractConflictingFiles(out), ["src/lib/foo.ts"]);
});

test("extractConflictingFiles: multiple content-merge conflicts, sorted + deduped", () => {
  const out = [
    "Auto-merging src/lib/b.ts",
    "CONFLICT (content): Merge conflict in src/lib/b.ts",
    "Auto-merging scripts/a.ts",
    "CONFLICT (content): Merge conflict in scripts/a.ts",
    "CONFLICT (content): Merge conflict in src/lib/b.ts", // duplicate — deduped
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n");
  assert.deepEqual(extractConflictingFiles(out), ["scripts/a.ts", "src/lib/b.ts"]);
});

test("extractConflictingFiles: rebase output shape (Auto-merging + CONFLICT + error)", () => {
  // A `git rebase origin/main` conflict emits the same CONFLICT lines as `git merge` plus a
  // trailing `error: could not apply <sha>...`.  The parser must still name the files.
  const out = [
    "Auto-merging docs/brain/libraries/creative-qc.md",
    "CONFLICT (content): Merge conflict in docs/brain/libraries/creative-qc.md",
    "Auto-merging docs/brain/libraries/ad-creative.md",
    "CONFLICT (content): Merge conflict in docs/brain/libraries/ad-creative.md",
    "error: could not apply 1234abc... build: some phase",
    'hint: Resolve all conflicts manually, mark them as resolved with',
    'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
  ].join("\n");
  assert.deepEqual(
    extractConflictingFiles(out),
    ["docs/brain/libraries/ad-creative.md", "docs/brain/libraries/creative-qc.md"],
  );
});

test("extractConflictingFiles: modify/delete shape", () => {
  const out = [
    "CONFLICT (modify/delete): src/lib/removed.ts deleted in HEAD and modified in origin/main. Version origin/main of src/lib/removed.ts left in tree.",
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n");
  assert.deepEqual(extractConflictingFiles(out), ["src/lib/removed.ts"]);
});

test("extractConflictingFiles: rename/rename shape names the source AND both destinations", () => {
  const out = [
    'CONFLICT (rename/rename): Rename "src/lib/old.ts"->"src/lib/new-a.ts" in branch "HEAD" rename "src/lib/old.ts"->"src/lib/new-b.ts" in "origin/main"',
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n");
  // The CEO card wants every path involved — the source both branches renamed AND each destination.
  assert.deepEqual(
    extractConflictingFiles(out),
    ["src/lib/new-a.ts", "src/lib/new-b.ts", "src/lib/old.ts"],
  );
});

test("extractConflictingFiles: no CONFLICT lines → empty (a clean merge or a novel git format)", () => {
  const out = "Auto-merging src/lib/foo.ts\nMerge made by the 'recursive' strategy.";
  assert.deepEqual(extractConflictingFiles(out), []);
});

test("extractConflictingFiles: ignores Auto-merging without a CONFLICT (clean merge line)", () => {
  // Auto-merging is emitted for BOTH successful and conflicting merges; without a matching CONFLICT
  // line for the same file, we must NOT name it (would false-positive on a clean merge).
  const out = [
    "Auto-merging src/lib/clean.ts",
    "Auto-merging src/lib/conflict.ts",
    "CONFLICT (content): Merge conflict in src/lib/conflict.ts",
  ].join("\n");
  assert.deepEqual(extractConflictingFiles(out), ["src/lib/conflict.ts"]);
});

test("formatReconcileConflictError: names files + strategies for the CEO card", () => {
  const err = formatReconcileConflictError({
    strategies: ["merge", "rebase"],
    files: ["scripts/builder-worker.ts", "src/lib/creative-qa.md"],
  });
  assert.match(err, /real conflict on 2 file\(s\)/);
  assert.match(err, /merge \+ rebase/);
  assert.match(err, /scripts\/builder-worker\.ts/);
  assert.match(err, /src\/lib\/creative-qa\.md/);
});

test("formatReconcileConflictError: caps the file list + shows overflow count", () => {
  // A CEO card should stay scannable — the format caps at 8 named files and appends `+N more`.
  const files = Array.from({ length: 12 }, (_, i) => `file${String(i).padStart(2, "0")}.ts`);
  const err = formatReconcileConflictError({ strategies: ["merge", "rebase"], files });
  assert.match(err, /real conflict on 12 file\(s\)/);
  assert.match(err, /file00\.ts/);
  assert.match(err, /file07\.ts/); // 8th, last shown
  assert.doesNotMatch(err, /file08\.ts/); // truncated
  assert.match(err, /\+4 more/);
});

test("formatReconcileConflictError: empty file list falls back to the strategies + see-log-tail hint", () => {
  // A real conflict where git output didn't yield a parseable file list — the message MUST NOT
  // silently claim zero files (a stale-only-shaped error); it points the operator at log_tail.
  const err = formatReconcileConflictError({ strategies: ["merge", "rebase"], files: [] });
  assert.match(err, /real conflict/);
  assert.match(err, /log_tail/);
  assert.match(err, /merge \+ rebase/);
});
