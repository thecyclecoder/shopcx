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

## Status / open work

Shipped 2026-07-11 ([[../archive.d/builder-self-heals-stale-build-branch-instead-of-refailing-to-ceo]]). Phase 1 merged the rebase→merge hotfix that self-heals a stale build branch (non-linear history recurses via `git merge` instead of `git rebase`); Phase 2 names conflicting files on a real-conflict escalation to the CEO, distinguishing stale-only from genuine semantic conflicts.
