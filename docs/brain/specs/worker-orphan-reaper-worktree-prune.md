# Worker-orphan-reaper: prune stale worktrees + idempotent resume worktree-add ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[worker-orphan-reaper]]. · **Found in use 2026-06-22:** the `auto-ship-pipeline` build **failed on resume** — `worktree add (resume) failed: fatal: 'claude/auto-ship-pipeline-mqpgwyds' is already used by worktree at '/home/builder/builds/2b9a3216-…'`. And a manual sweep found **3 stale worktrees** for terminal/merged branches (e.g. `control-tower-complete-coverage` PR #189, long-merged) that nothing had reaped. The reaper handles orphaned *jobs* but not orphaned *worktrees*.

Two distinct failures, one root: the box never cleans git worktrees.
1. **Resume blows up** — a build pauses for approval, the owner approves → the box re-claims and runs `git worktree add <branch>`, but a worktree for that branch **already exists** from the first run → fatal, the build fails (the work was fine; the infra wasn't).
2. **Stale worktrees accumulate** — a build completes/merges/fails but its worktree (and disk) lingers; `git worktree prune` alone won't remove it (the directory still exists), so they pile up until they collide or fill disk.

## Fix (extend `reapOrphans` + the worktree-add path in `scripts/builder-worker.ts`)
- **Idempotent worktree-add (kills failure #1):** before `git worktree add <path> <branch>` (build AND resume paths), if a worktree for `<branch>` already exists, **`git worktree remove --force` it first** (or reuse it) — so the add can never fail with "already used by worktree." A resume must be able to re-establish its tree.
- **Worktree reaping (kills failure #2):** `reapOrphans` (runs at startup + periodically) lists `git worktree list`, and for each build worktree under `builds/` whose backing **agent_job is terminal** (`completed`/`merged`/`failed`/`cancelled`) OR whose **branch is deleted on the remote** → `git worktree remove --force <path>` + `rm -rf` the dir + `git worktree prune`. **Active jobs' worktrees are never touched** (status in queued/claimed/building/needs_input/needs_approval/queued_resume).
- Runs as the worker's own user (correct git ownership — no "dubious ownership"); tolerate a worktree whose dir is already gone (prune the admin entry).

## Verification
- Leave a worktree for a merged/terminal-job branch on the box → within one reaper cycle it's removed (worktree + dir gone, `git worktree list` clean); a worktree for an **active** build is left alone.
- Pause a build for approval, approve it → the resume's `git worktree add` **succeeds** even though the first run left a worktree for that branch (it's force-removed/reused first) — no "already used by worktree" fatal.
- After a build merges (branch deleted) → its worktree is reaped, not left as cruft; disk under `builds/` doesn't grow unboundedly.
- Negative: a worktree whose job is still `building` / `needs_approval` is NEVER reaped (no killing a live build).

## Phase 1 — idempotent worktree-add + worktree reaping in reapOrphans ⏳

> **False-✅ corrected 2026-06-22:** spec was marked shipped but NO build ever ran (only a spec-test) and reapOrphans has no worktree code. Reverted to ⏳; real build queued.
Add the pre-add force-remove (build + resume paths) and the terminal-job/deleted-branch worktree sweep to `reapOrphans` in `scripts/builder-worker.ts`. Brain: [[worker-orphan-reaper]] · [[../recipes/build-the-box]] (if present) · [[../operational-rules]].
