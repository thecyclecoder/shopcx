# Worker Orphan-Reaper — reset in-flight jobs left by a dead worker ⏳

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
- Claim a `spec-test` (it goes `building`), restart the worker (`systemctl restart shopcx-builder`) → on boot the orphaned spec-test is **reset to `queued`** and re-runs; no row lingers in `building`; the Control Tower stuck-jobs alert never fires. (Re-validates the 7-orphan incident.)
- Same with a `build` mid-flight → boot marks it `failed` ("orphaned by worker restart"); the failed-builds callout shows it; if its branch was pushed, **Create PR** recovers it.
- A clean restart with no in-flight jobs → reaper logs "0 reaped", no-op.
- A job the *current* worker is actively building (claimed after `started_at`) → never touched.

## Phase 1 — startup reaper ⏳
The boot-time reap in `scripts/builder-worker.ts` (before the poll loop): query orphans (`building`/`claimed`/`queued_resume` with `claimed_at < started_at`), reset re-runnable kinds → `queued`, fail producer kinds, log the counts. Brain: [[../recipes/build-box-setup]] · [[../tables/agent_jobs]] · [[control-tower]] (the stuck-jobs check this removes the false-positive source for) · [[build-recover-pr-create]] (recovers failed-producer orphans).
