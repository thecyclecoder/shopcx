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
  classifyAdditiveOnlyConflict,
  parseConflictHunks,
  UNION_RESOLVABLE_PATHS,
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

// ── Phase 1 (spec: additive-only-conflict-resolves-itself) — classifier fixtures ────────────────
//
// Pins the three real 2026-08-02 collisions as fixtures — the two package.json script adds and
// the brain-page bullet-list extension — plus negatives that must STILL park: two edits to the
// same script line, a deletion on one side, and any `.ts` conflict.  The whole design value is
// that this tier never guesses; the negatives prove it.

test("UNION_RESOLVABLE_PATHS: package.json and docs/brain/**/*.md only, no source", () => {
  assert.ok(UNION_RESOLVABLE_PATHS.some((r) => r.test("package.json")));
  assert.ok(UNION_RESOLVABLE_PATHS.some((r) => r.test("docs/brain/libraries/foo.md")));
  assert.ok(UNION_RESOLVABLE_PATHS.some((r) => r.test("docs/brain/specs/deep/nested/thing.md")));
  // Source files intentionally NOT in the allowlist — a source conflict is semantic by default.
  assert.ok(!UNION_RESOLVABLE_PATHS.some((r) => r.test("src/lib/foo.ts")));
  assert.ok(!UNION_RESOLVABLE_PATHS.some((r) => r.test("src/lib/foo.tsx")));
  assert.ok(!UNION_RESOLVABLE_PATHS.some((r) => r.test("package-lock.json")));
  assert.ok(!UNION_RESOLVABLE_PATHS.some((r) => r.test("docs/brain/README.md/.ts"))); // pathologic
});

test("parseConflictHunks: diff3 hunk yields ours / base / theirs with hasBaseMarker=true", () => {
  const content = [
    "before",
    "<<<<<<< HEAD",
    "our line",
    "||||||| merged common ancestors",
    "base line",
    "=======",
    "their line",
    ">>>>>>> origin/main",
    "after",
  ].join("\n");
  const hunks = parseConflictHunks(content);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].ours, ["our line"]);
  assert.deepEqual(hunks[0].base, ["base line"]);
  assert.deepEqual(hunks[0].theirs, ["their line"]);
  assert.equal(hunks[0].hasBaseMarker, true);
  assert.equal(hunks[0].startLine, 1);
});

test("parseConflictHunks: 2-way hunk (no |||||||) sets hasBaseMarker=false + empty base", () => {
  const content = [
    "<<<<<<< HEAD",
    "our",
    "=======",
    "their",
    ">>>>>>> main",
  ].join("\n");
  const hunks = parseConflictHunks(content);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].hasBaseMarker, false);
  assert.deepEqual(hunks[0].base, []);
});

test("classifyAdditiveOnlyConflict FIXTURE 1: package.json — two adjacent script adds (2026-08-02 collision)", () => {
  // The `no-send-path-can-emit-an-unsubstituted-placeholder` shape: main added `test:meta-ads-
  // create`, branch added `test:ticket-delivery-placeholder-guard` — adjacent lines in the
  // scripts object.  Union of both sides is the correct resolve.
  const content = [
    "{",
    '  "name": "shopcx",',
    '  "scripts": {',
    '    "build": "next build",',
    '    "existing": "npm run something",',
    "<<<<<<< HEAD",
    '    "test:meta-ads-create": "npx tsx scripts/test-meta-ads-create.ts",',
    "||||||| merged common ancestors",
    "=======",
    '    "test:ticket-delivery-placeholder-guard": "npx tsx scripts/test-placeholder.ts",',
    ">>>>>>> origin/main",
    '    "start": "next start"',
    "  },",
    '  "dependencies": {}',
    "}",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "package.json", content });
  assert.equal(v.additive, true, JSON.stringify(v));
  if (v.additive) {
    assert.match(v.unionContent, /test:meta-ads-create/);
    assert.match(v.unionContent, /test:ticket-delivery-placeholder-guard/);
    assert.doesNotMatch(v.unionContent, /<<<<<<<|=======|>>>>>>>|\|{7}/);
  }
});

test("classifyAdditiveOnlyConflict FIXTURE 2: package.json — SECOND real collision shape (both sides add)", () => {
  // Same shape as Fixture 1 but with adjacent-add ordering flipped and 4 existing scripts, so
  // we prove the classifier isn't tied to a specific fixture layout.
  const content = [
    "{",
    '  "scripts": {',
    '    "a": "x",',
    '    "b": "y",',
    "<<<<<<< HEAD",
    '    "test:new-a": "npx tsx a.ts",',
    "||||||| merged common ancestors",
    "=======",
    '    "test:new-b": "npx tsx b.ts",',
    ">>>>>>> origin/main",
    '    "c": "z"',
    "  }",
    "}",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "package.json", content });
  assert.equal(v.additive, true, JSON.stringify(v));
});

test("classifyAdditiveOnlyConflict FIXTURE 3: docs/brain markdown — bullet-list extension (2026-08-02)", () => {
  // The `replacement-orders-label-honestly-and-cap-at-four-units` collision: both sides
  // extended the same bullet list in a brain page.  Union of the two added items is correct.
  const content = [
    "# Replacement orders",
    "",
    "The rules:",
    "",
    "- one unit per SKU by default",
    "- label truthfully",
    "<<<<<<< HEAD",
    "- cap at four units per variant",
    "||||||| merged common ancestors",
    "=======",
    "- label honestly across the flow",
    ">>>>>>> origin/main",
    "- return-authorization is separate",
    "",
    "## Notes",
    "Some prose.",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({
    path: "docs/brain/libraries/replacement-orders.md",
    content,
  });
  assert.equal(v.additive, true, JSON.stringify(v));
  if (v.additive) {
    assert.match(v.unionContent, /cap at four units per variant/);
    assert.match(v.unionContent, /label honestly across the flow/);
    assert.doesNotMatch(v.unionContent, /<<<<<<<|=======|>>>>>>>|\|{7}/);
  }
});

test("classifyAdditiveOnlyConflict NEGATIVE: two edits to the same script line — base non-empty, must park", () => {
  // The classic dangerous case the classifier MUST reject: both sides changed the SAME script's
  // command.  A union resolve would produce a duplicate JSON key.  The diff3 base carries the
  // pre-change line, so `base.length !== 0` → not additive.
  const content = [
    "{",
    '  "scripts": {',
    "<<<<<<< HEAD",
    '    "test": "npm run test:one"',
    "||||||| merged common ancestors",
    '    "test": "npm test"',
    "=======",
    '    "test": "npm run test:two"',
    ">>>>>>> origin/main",
    "  }",
    "}",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "package.json", content });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /common ancestor|modified or deleted/i);
});

test("classifyAdditiveOnlyConflict NEGATIVE: deletion on one side — empty ours, must park", () => {
  // A deletion presents as an EMPTY side (the deleter contributed nothing).  Even if the other
  // side merely added, the collision isn't 'both sides appended' — it's 'one deleted, one kept
  // + added'.  The safe verdict is park.
  const content = [
    "- keep",
    "<<<<<<< HEAD",
    "- new item HEAD wants",
    "||||||| merged common ancestors",
    "- item origin/main wants to delete",
    "=======",
    ">>>>>>> origin/main",
    "- also keep",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "docs/brain/libraries/foo.md", content });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /modified or deleted|empty/i);
});

test("classifyAdditiveOnlyConflict NEGATIVE: any .ts conflict — parks unconditionally", () => {
  // Source files are semantic by default; no heuristic is trusted with them.  Even a shape
  // that would qualify in package.json (empty base, both sides added) must park in a .ts file.
  const content = [
    "export function foo() {",
    "<<<<<<< HEAD",
    "  const a = 1;",
    "||||||| merged common ancestors",
    "=======",
    "  const b = 2;",
    ">>>>>>> origin/main",
    "}",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "src/lib/foo.ts", content });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /UNION_RESOLVABLE_PATHS|source files park/i);
});

test("classifyAdditiveOnlyConflict NEGATIVE: 2-way conflict (no ||||||| marker) — unknown base parks", () => {
  // Without diff3, the base is unknown and neither-side-overwrote-a-base-line cannot be
  // proven.  The classifier MUST park — a guess here defeats the design.
  const content = [
    "{",
    '  "scripts": {',
    '    "a": "x",',
    "<<<<<<< HEAD",
    '    "b": "y"',
    "=======",
    '    "c": "z"',
    ">>>>>>> main",
    "  }",
    "}",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "package.json", content });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /diff3|base marker/i);
});

test("classifyAdditiveOnlyConflict NEGATIVE: package.json conflict OUTSIDE the scripts object", () => {
  // A both-sides-added collision, empty base, both non-empty — but in the `dependencies`
  // object, not `scripts`.  The scope guard MUST reject it.
  const content = [
    "{",
    '  "scripts": {',
    '    "build": "next build"',
    "  },",
    '  "dependencies": {',
    "<<<<<<< HEAD",
    '    "libA": "^1.0.0",',
    "||||||| merged common ancestors",
    "=======",
    '    "libB": "^2.0.0",',
    ">>>>>>> origin/main",
    '    "libC": "^3.0.0"',
    "  }",
    "}",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "package.json", content });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /"scripts" object|outside/i);
});

test("classifyAdditiveOnlyConflict NEGATIVE: markdown conflict on paragraph prose — not append-shaped", () => {
  // A both-sides-added collision in a brain page whose content is prose paragraphs, not list
  // items or headers.  Even though the base is empty, an added paragraph mid-flow is not the
  // 'appended shape' the spec restricts to.
  const content = [
    "# Title",
    "",
    "Existing paragraph.",
    "<<<<<<< HEAD",
    "This whole new paragraph was added by HEAD and continues freely.",
    "||||||| merged common ancestors",
    "=======",
    "Meanwhile origin/main inserted a different prose paragraph here.",
    ">>>>>>> origin/main",
    "Trailing paragraph.",
  ].join("\n");
  const v = classifyAdditiveOnlyConflict({ path: "docs/brain/lifecycles/foo.md", content });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /append-shaped/i);
});

test("classifyAdditiveOnlyConflict: no hunks in content → park with a clear reason", () => {
  const v = classifyAdditiveOnlyConflict({ path: "package.json", content: '{"scripts":{}}' });
  assert.equal(v.additive, false);
  if (!v.additive) assert.match(v.reason, /no conflict hunks/i);
});
