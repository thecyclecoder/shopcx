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
- After a successful reconcile, the caller tsc-gates the reconciled tree BEFORE the claude run — a broken origin/main (base poison) parks with the tsc output so the operator sees the real reason, never spending claude tokens on a broken base.

## Spec of record

- [[../specs/builder-self-heals-stale-build-branch-instead-of-refailing-to-ceo]] — Phase 1 folds `mario-rebase-parked-build-worktrees-onto-main-before-repo-wide-checks` Phase 1 + the 2026-07-11 rebase→merge hotfix into a single strategy-driven reconcile.
