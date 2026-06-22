# Worker-orphan-reaper: prune stale worktrees + idempotent resume worktree-add ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[worker-orphan-reaper]]. · **Found in use 2026-06-22:** the `auto-ship-pipeline` build **failed on resume** — `worktree add (resume) failed: fatal: 'claude/auto-ship-pipeline-mqpgwyds' is already used by worktree at '/home/builder/builds/2b9a3216-…'`. And a manual sweep found **3 stale worktrees** for terminal/merged branches (e.g. `control-tower-complete-coverage` PR #189, long-merged) that nothing had reaped. The reaper handles orphaned *jobs* but not orphaned *worktrees*.

Two distinct failures, one root: the box never cleans git worktrees.
1. **Resume blows up** — a build pauses for approval, the owner approves → the box re-claims and runs `git worktree add <branch>`, but a worktree for that branch **already exists** from the first run → fatal, the build fails (the work was fine; the infra wasn't).
2. **Stale worktrees accumulate** — a build completes/merges/fails but its worktree (and disk) lingers; `git worktree prune` alone won't remove it (the directory still exists), so they pile up until they collide or fill disk.

## Fix (extend `reapOrphans` + the worktree-add path in `scripts/builder-worker.ts`)
- **Idempotent worktree-add (kills failure #1):** before `git worktree add <path> <branch>` (build AND resume paths), if a worktree for `<branch>` already exists, **`git worktree remove --force` it first** (or reuse it) — so the add can never fail with "already used by worktree." A resume must be able to re-establish its tree.
- **Worktree reaping (kills failure #2):** `reapOrphans` (runs at startup + periodically) lists `git worktree list`, and for each build worktree under `builds/` whose backing **agent_job is terminal** (`completed`/`merged`/`failed`/`cancelled`) OR whose **branch is deleted on the remote** → `git worktree remove --force <path>` + `rm -rf` the dir + `git worktree prune`. **Active jobs' worktrees are never touched** (status in queued/claimed/building/needs_input/needs_approval/queued_resume).
- Runs as the worker's own user (correct git ownership — no "dubious ownership"); tolerate a worktree whose dir is already gone (prune the admin entry).

## Verification
- On the box, leave a `builds/<uuid>` worktree whose `agent_jobs` row is `completed`/`failed` (or delete the row) → restart the worker (`systemctl restart shopcx-builder`) → expect a `[reaper] reaped stale worktree builds/<uuid> (job completed|missing)` log line and that worktree + dir gone from `git worktree list` within that startup's `reapOrphans` pass.
- On the box, create a worktree for a branch (`git worktree add builds/x -B claude/foo origin/main`), then run the build job for a job whose `spec_branch=claude/foo` → expect the build/resume `git worktree add` to **succeed** (no "already used by worktree at …" fatal) because `removeWorktreeForBranch` force-removed the prior tree first.
- On the box, after a build PR merges and its branch is deleted → expect its `builds/<job.id>` worktree reaped on the next worker startup (terminal/missing job), and `du -sh builds/` not growing unboundedly across restarts.
- Negative: stand up a `builds/<uuid>` worktree whose job row is `building` or `needs_approval` → run `reapOrphans` → expect that worktree **kept** (counted in the `[reaper] worktrees: removed N terminal/orphaned, kept M active` line), never removed.
- `npx tsc --noEmit` on `scripts/builder-worker.ts` → expect clean.

## Phase 1 — idempotent worktree-add + worktree reaping in reapOrphans ✅

> **False-✅ corrected 2026-06-22:** spec was marked shipped but NO build ever ran (only a spec-test) and reapOrphans has no worktree code. Reverted to ⏳; real build queued.
> **Built 2026-06-22:** `scripts/builder-worker.ts` now carries the worktree-reaping helpers + the sweep is wired into `reapOrphans`; the build job's build + resume `git worktree add` are force-remove-by-branch idempotent. tsc-clean.

Add the pre-add force-remove (build + resume paths) and the terminal-job/deleted-branch worktree sweep to `reapOrphans` in `scripts/builder-worker.ts`. Brain: [[worker-orphan-reaper]] · [[../recipes/build-the-box]] (if present) · [[../operational-rules]].

### What landed
- `listWorktrees()` — parses `git worktree list --porcelain` → `[{ path, branch }]` (refs/heads/ stripped, null when detached).
- `removeWorktreeDir(path)` — `git worktree remove --force` + `rm -rf` any lingering dir; tolerates an already-gone dir (a later `git worktree prune` reconciles the admin entry). Never throws.
- `removeWorktreeForBranch(branch)` — force-removes ANY worktree currently holding `<branch>`, then prunes. Called immediately **before** `git worktree add -B <branch>` on BOTH the build job's fresh-build and resume paths (`runBuildJob`), so a resume can never fatal with "already used by worktree at …".
- `reapOrphanWorktrees()` — sweeps every `builds/<job.id>` worktree (UUID basename; `spec-chat-*`/`dev-ask-*` lanes excluded) whose backing `agent_jobs` row is **terminal** (`completed`/`failed`/`needs_attention`) or **no longer exists** (how a merged-and-deleted branch surfaces). Worktrees for jobs in `ACTIVE_JOB_STATUSES` (`queued`/`claimed`/`building`/`needs_input`/`needs_approval`/`queued_resume`) are **never** touched. Wired into `reapOrphans`, which runs at worker startup (and thus every self-update restart) and always runs the worktree sweep even when 0 jobs were orphaned.
