# Worker Orphan-Reaper — reset in-flight jobs left by a dead worker ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[roadmap-build-console]] + [[../recipes/build-box-setup]]. Box-worker reliability.

When the box worker restarts — a **self-update** (`git reset --hard origin/main` + exit → systemd relaunch), a deploy, or a crash — any job it had **in flight** (`status` `building`/`claimed`) is **orphaned**: the new worker only claims `queued`, so the old in-flight rows sit in `building` **forever**. They never complete, and the Control Tower correctly flags them as **stuck** ("N jobs stuck in building past 60m"). Observed live: across several deploys this session, **7 spec-test jobs** piled up orphaned in `building` (each restart orphaned the then-running ones), tripping a stuck-jobs alert that read as a false alarm but was real. The worker must **reap orphans on startup**.

## Model — reap on boot, by kind
On worker startup (before the poll loop), find every job **claimed by a previous instance** — `status IN ('building','claimed','queued_resume')` AND `claimed_at < <this worker's started_at>` (the heartbeat `started_at` is the cutoff; nothing the *current* instance owns is touched) — and reap it by kind:
- **Re-runnable / idempotent kinds** (`spec-test`, `triage-escalations`, `migration-fix`, `dev-ask`, `pr-resolve`) → **reset to `queued`** (clear `claimed_at`) so they simply re-run. No work lost.
- **Work-producing kinds** (`build`, `plan`, `fold`, `product-seed`, `spec-chat`, `ticket-improve`) → a restart may have left a half-pushed branch / partial state, so **mark `failed`** with `error="orphaned by worker restart"` (NOT silently re-run, which could double-push). The **failed-builds callout** ([[../dashboard/roadmap]]) then surfaces it, and if a branch was actually pushed, [[build-recover-pr-create]]'s **Create PR** recovers the completed work — no rebuild needed.
- **Log** the reap (count by kind) so a restart's cleanup is visible, not silent.

## Guardrails
- **Cutoff-gated:** only reaps jobs `claimed_at < started_at` — never a job the live instance is actively running (no mid-build kill).
- **Idempotent + safe:** runs once per boot; a clean restart with nothing orphaned is a no-op. Re-running it never double-reaps (the reaped rows are no longer `building`).
- **Conservative on producers:** a build is failed (visible + recoverable), never blindly re-queued, so we never double-push a branch.

## Verification
- With a `spec-test` job sitting in `building` (`claimed_at` older than the next boot), restart the worker (`systemctl restart shopcx-builder`) → the boot log shows `[reaper] reaped 1 orphan(s) … re-queued: spec-test×1; failed: none`, the row is back to `status='queued'` with `claimed_at=null`, it re-runs, and the Control Tower "N jobs stuck in building" alert never fires. (Re-validates the 7-orphan incident.)
- With a `build` job in `building` (old `claimed_at`) at boot → reaper log shows `failed: build×1`, the row is `status='failed'` with `error='orphaned by worker restart'`, the failed-builds callout on [[../dashboard/roadmap]] surfaces it, and if its branch was pushed, **Create PR** ([[build-recover-pr-create]]) recovers the work — no rebuild.
- Restart the worker with no in-flight jobs → boot log reads `[reaper] 0 reaped — no orphaned in-flight jobs from a previous instance`; no rows change.
- Confirm a job the *current* instance owns is never reaped: while the worker is actively running a job (its `claimed_at ≥ WORKER_STARTED_AT`), the reap query (`status IN ('building','claimed','queued_resume') AND claimed_at < WORKER_STARTED_AT`) excludes it — verify in the DB that an actively-building job's status is untouched across the boot reap.

## Phase 1 — startup reaper ✅
Shipped in `scripts/builder-worker.ts`: `reapOrphans()` runs in `main()` **before the poll loop** (best-effort, wrapped so a reaper failure never blocks startup). It queries orphans (`status IN ('building','claimed','queued_resume')` AND `claimed_at < WORKER_STARTED_AT` — the heartbeat cutoff, so nothing the current instance owns is touched), then per kind: re-runnable kinds (`RERUNNABLE_KINDS` = `spec-test`/`triage-escalations`/`migration-fix`/`dev-ask`/`pr-resolve`) → reset to `queued` + clear `claimed_at`; work-producer kinds (`build`/`plan`/`fold`/`product-seed`/`spec-chat`/`ticket-improve`) → `failed` with `error='orphaned by worker restart'`; logs the counts by kind (`0 reaped` on a clean boot). `RERUNNABLE_KINDS` is the single shared source of truth — the self-update `sacrosanctActive` check (lanes a restart may interrupt) now reads the same constant, so the "safe to re-run" definition can't drift between reaper and self-update. No migration (free-text `kind`, existing columns). Brain: [[../recipes/build-box-setup]] · [[../tables/agent_jobs]] · [[control-tower]] (the stuck-jobs check this removes the false-positive source for) · [[build-recover-pr-create]] (recovers failed-producer orphans).
