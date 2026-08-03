# build-lane-reconcile

Pure strategy chooser for the build lane's per-claim reconcile of a `claude/build-{slug}` branch against `origin/main`, before the box runs the claude session and repo-wide checks. No I/O.

- **File:** `src/lib/build-lane-reconcile.ts`
- **Test:** `src/lib/build-lane-reconcile.test.ts` — pinned failing-state coverage (goal-member with merge commits ⇒ merge-first; box-local no-built-work ⇒ recreate-fresh; hasBuiltWork ⇒ never recreate-fresh).
- **Caller:** `scripts/builder-worker.ts` — the reconcile block inside `dispatchJob` (grep `builder-self-heals-stale-build-branch Phase 1`).

## Why

The build lane MUST advance a branch's base to CONTAIN `origin/main` before running repo-wide checks (`npx tsc --noEmit`, `_check-table-refs-have-migrations.ts`) — those checks assume main as the reference tree. A branch that was cut before a table-creating migration landed on main would otherwise fail `check:table-refs-have-migrations` on a stale base whose fix already shipped, stalling the spec on a non-real regression.

A `git rebase origin/main` linearly replays the branch's commits and SPURIOUSLY conflicts on non-linear history — a goal-member branch inherits merge commits from the goal branch's reconciliation with main, and rebase replays those merges and hits the SAME conflict every retry, even though `git merge origin/main` applies clean. Confirmed 2026-07-11: director-chat-in-leash-execution and machine-declared-verification-and-deterministic-spec-test-runner both parked at needs_attention, and the escort/groom loop guard escalated the self-healable staleness twice to the CEO inbox. That is the "silent-proxy failure the north star forbids" the spec names — a bounded retry proxy that escalated the wrong signal.

## Choice matrix

| Branch state                                | Primary          | Fallback                                                              |
| ------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `headContainsMain=true`                     | `skip`           | `skip`                                                                |
| `hasMergeCommits=true` (non-linear)         | `merge`          | `rebase` (or `recreate-fresh` when no built work + not on origin)     |
| `hasMergeCommits=false` (truly linear)      | `rebase`         | `merge` (or `recreate-fresh` when no built work + not on origin)      |

`recreate-fresh` is HARD-GATED by `hasBuiltWork=false AND branchOnRemote=false` — a phase's `build_sha` is durable state the fallback must NEVER drop, and a pushed branch must NEVER have its remote history rewritten (would need `push --force`, forbidden). Only a truly throwaway box-local branch resets to the correct base (goal branch for a member, else `origin/main`).

## Invariants

- NEVER force-push, NEVER touch main, NEVER drop BUILT commits.
- ONE reconcile attempt per claim: primary + a single fallback. When BOTH conflict the divergence is genuine and the caller parks `needs_attention`.
- After a successful reconcile, the caller tsc-gates the reconciled tree BEFORE the claude run — a broken origin/main (base poison) parks with the tsc output so the operator sees the real reason, never spending claude tokens on a broken base. **base-poison-verify-main-alone (2026-07-17):** a reconciled-tree tsc failure NO LONGER assumes main is broken — the caller now tsc's `origin/main` ALONE (`isOriginMainTscClean`, a throwaway detached worktree) before blaming it. A STALE branch (built before a breaking main change — e.g. a goal promotion that added a required field) fails to compile with the new main even though main alone is fine; that is the BRANCH's own failure → proceed to the build session to fix it (the post-build deploy gate / spec-test re-checks tsc), NOT `base_poison`. Only a genuinely-broken main-alone parks `base_poison`. Fail-open (a worktree/tsc harness hiccup → treat main as clean + proceed) so a healthy pipeline is never falsely halted. This closed the 2026-07-17 Bianca stall: `bianca-route-ready-creatives`'s branch parked `base_poison` on the Dahlia goal's new required `descriptions` field while main was actually clean.

## Phase 2 — Name the conflicting files on a real-conflict park

`extractConflictingFiles(gitOutput)` parses the sorted, deduplicated file list from the RAW output of a failing `git merge` / `git rebase`. Shapes covered: `CONFLICT (content): Merge conflict in <path>`, `CONFLICT (modify/delete): <path> deleted in <ref> ...`, `CONFLICT (rename/rename): Rename "<src>"->"<dst-a>" ... rename "<src>"->"<dst-b>" ...`. `Auto-merging <path>` lines are IGNORED unless a paired CONFLICT line for the same file appears (a clean merge emits Auto-merging without CONFLICT — naming those files would false-positive).

`formatReconcileConflictError({ strategies, files })` composes the operator-facing park `error` string. Caps at 8 named files with a `+N more` overflow tag so the CEO card stays scannable; on an empty file list (a real conflict whose git output was novel enough to defeat the parser) it falls back to a "see log_tail" hint that still names the strategies attempted.

The builder-worker's real-conflict park (grep `Phase 2 — Escalate only a REAL conflict`) accumulates the raw git output from BOTH the primary AND fallback attempts and passes their union to `extractConflictingFiles`, so a divergence that surfaces on `merge` but not `rebase` (or vice versa) still appears in the error. `needs_attention_class` is stamped `"reconcile_conflict"` so the standard classifier ([[needs-attention-classify]]) bypasses this row — the file list IS the routing signal. A distinct `"base_poison"` class is stamped on the tsc-gate failure (post-successful-reconcile, main itself is broken) so the two POST-self-heal park classes can be triaged separately: `reconcile_conflict` needs a spec-level merge, `base_poison` needs a main hotfix. Both count toward the escort loop-guard's 2×→CEO trip because both are real, actionable signals; a self-healable staleness never parks at all because Phase 1's merge fallback / recreate-fresh handles it.

## Additive-only third tier (2026-08-03)

When the primary AND fallback both conflict, a THIRD tier runs before the park — a bounded union resolve for conflicts that are provably additive-only in known append-shaped files. The intent is targeted: three founder escalations landed on 2026-08-02 for collisions where both sides simply *appended* (two `test:*` scripts added to `package.json`, a `- bullet` added to the same brain-page list, a phase-push rebase against a sibling push). Every one was resolved by hand in under a minute by keeping both sides; none had anything wrong with the code. That is the normal shape of two-specs-shipping-the-same-day work, not an edge case.

### The pure classifier — `classifyAdditiveOnlyConflict`

`classifyAdditiveOnlyConflict({ path, content }): { additive:true, unionContent } | { additive:false, reason }`. No I/O. Verdict is `additive:true` ONLY when EVERY conflict hunk in the file satisfies:

1. The hunk carries the diff3 base marker (`|||||||`). The caller runs the failing merge with `-c merge.conflictStyle=diff3` so the base is visible; a plain 2-way hunk with no base is UNKNOWN and parks — no guessing.
2. The base block is EMPTY. A non-empty common ancestor means at least one side modified or deleted a line the other also touched — not additive.
3. Both `ours` and `theirs` blocks are non-empty. A one-sided add merges cleanly and never conflicts.

AND the file path is in the `UNION_RESOLVABLE_PATHS` allowlist AND all hunks fall within the shape-specific scope.

### The allowlist — `UNION_RESOLVABLE_PATHS`

```ts
export const UNION_RESOLVABLE_PATHS: readonly RegExp[] = [
  /^package\.json$/,
  /^docs\/brain\/.+\.md$/,
];
```

- **`package.json`** — every hunk must fall inside the `"scripts": { ... }` object body (brace-depth tracked from the scripts opener). A conflict in `dependencies` or the top-level object structure parks.
- **`docs/brain/**/*.md`** — every ours/theirs line must be an append-shaped markdown fragment: a list item (`- ` / `* ` / `+ ` / `1. `), an ATX header (`#` … `######` — an appended section), a blank line, or a list-item continuation (`  ` indented). A paragraph edit is NOT append-shaped and parks.

### Why source files (`.ts`/`.tsx`) are excluded — by design

A source conflict is semantic by default and no heuristic should be trusted with it. Even a `.ts` collision that *shapes* like an additive-only hunk (both sides added a function, empty base, both non-empty) can carry semantic overlap the classifier can't see — a re-exported symbol name that now clashes, a stale import path from one side, a control-flow assumption from the other. The classifier returns `not-additive` for every path outside the allowlist with a specific reason (`path <path> is not in UNION_RESOLVABLE_PATHS — source files park by design`). Adding a new shape to the allowlist is deliberate: an explicit regex entry AND its own scope check — never a wildcard.

### Post-resolve validation — the safety net

Classification says "the shape is additive"; validation says "the tree we actually wrote is safe." An auto-resolve that lands a broken file is far worse than a park. The caller runs EVERY validator on EVERY auto-resolved file BEFORE completing the merge:

- `validateNoConflictMarkers(content)` — no `<<<<<<<`, `|||||||`, `=======`, or `>>>>>>>` line remains.
- `validateUnionSuperset(ours, theirs, resolved)` — every non-empty line from either prior side survives in the resolved content (git stages `:2:` and `:3:` are the ground truth for ours/theirs).
- `validatePackageJsonScriptKeys(ours, theirs, resolved)` — the resolved `package.json` parses as JSON AND every pre-existing `scripts.<key>` from either side is present.
- Tree-wide `git diff --cached --check` before commit — belt-and-suspenders catch for a marker that slipped past the per-file check.

A failed validation is a PARK, never a retry — no configuration of the resolver would change the verdict, so the caller aborts the merge and falls through to today's `reconcile_conflict` path.

### Invariants preserved

- **Never force-push** — the third tier produces a NEW merge commit on top of the branch; nothing is rewritten.
- **Never touch main** — the merge is INTO the branch; `origin/main` is untouched.
- **Never drop a commit carrying a `build_sha`** — a merge preserves every branch commit; only `recreate-fresh` (Phase 1) can drop them and this tier never runs it.

## Phase 3 — Actionable park + no-redrive-budget for reconcile_conflict

A `reconcile_conflict` park that survives the additive-only tier is a genuinely semantic conflict — the CEO card can't be another "Build stuck (grooming)" with the reason buried in `agent_jobs.error`.

- `conflictResolutionHintFor(path)` — pure, path-shape-keyed one-liner: `package.json` → *keep one script line from each side*, `docs/brain/**.md` → *keep the appended list items or sections from each side*, a lock file → *regenerate*, a `.ts`/`.tsx` → *semantic merge, source files are excluded from the additive-only tier by design*, anything else → *manual merge*.
- `formatConflictResolutionHints(files)` — one hint line per file (capped at 8, `+N more` overflow) — surfaced in the park's `error` string AND its `log_tail`. The CEO card renders BOTH at first park.
- A `reconcile_conflict` park does NOT consume `BUILDER_DEFERRED_REDRIVE_MAX` — that counter tracks `completed_with_deferred` post-build redrives ([[../libraries/roadmap-actions]] `redriveDeferredBuildOrEscalate`), a class a `needs_attention` park never enters. Its autonomous retry lane is [[../libraries/platform-director]] `escortSweep` → `reconcile_resolve` → `enqueuePrResolveJob` (a real auto-merge attempt via [[../libraries/github-pr-resolve]]), bounded by `ESCORT_LOOP_GUARD_MAX` and dedup-per-PR. Nothing about a REPEATED IDENTICAL reconcile changes — the actionable card is what the CEO / Platform director sees, not "the third redrive finally escalated."
- **Route to Platform, not the founder.** A merge conflict is Platform's mandate — CLAUDE.md's north-star rule pins the escalation to the layer below, not past it. The autonomous pr-resolve lane IS Platform's tool; the actionable card carries a Platform-owned dedupe so a founder never sees an unactionable "stuck build."

## Status / open work

Shipped 2026-07-11 ([[../archive.d/builder-self-heals-stale-build-branch-instead-of-refailing-to-ceo]]). Phase 1 merged the rebase→merge hotfix that self-heals a stale build branch (non-linear history recurses via `git merge` instead of `git rebase`); Phase 2 names conflicting files on a real-conflict escalation to the CEO, distinguishing stale-only from genuine semantic conflicts.

**Additive-only tier shipped 2026-08-03** (spec `an-additive-only-conflict-resolves-itself-instead-of-parking`): the third-tier union resolve + safety-net validators + actionable park surface, motivated by three founder escalations on 2026-08-02 for collisions where both sides simply appended.
