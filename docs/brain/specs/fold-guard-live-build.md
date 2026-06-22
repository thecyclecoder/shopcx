# Fold guard — don't archive a spec with a live build; reconcile jobs on archive ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens the fold path + [[auto-ship-pipeline]] (Gate B auto-fold) + [[worker-orphan-reaper]]. · **Found in use 2026-06-22:** `control-tower-escalation-idle-grace` was **folded + archived (#250) while a `needs_input` build for it was still live** — the build paused asking questions, the spec markdown moved to `archive.d/`, and the box then showed "1 build paused" with a link that **404'd** (the spec page is gone). A spec got folded out from under a running build.

A fold archives the spec markdown (moves it to `archive.d/`, removes the active card). If a non-terminal build/spec-test job for that spec is still alive, it becomes an **orphan**: it lingers in `needs_input`/`building`/etc., shows as a paused/active item, but its spec page 404s and answering it is meaningless (the spec is gone). This gets *more* likely once auto-fold runs automatically.

## Fix (two complementary guards)
- **Don't fold a spec with a live job (preventive).** The fold path (`enqueue_fold` / the verify→fold action + the auto-fold gate in [[auto-ship-pipeline]]) must **refuse / defer** folding a spec that has a non-terminal job (`queued`/`claimed`/`building`/`needs_input`/`needs_approval`/`queued_resume`). Fold only once the build is terminal (merged/completed/failed). Prevents the race at the source.
- **Reconcile jobs when a spec IS archived (cleanup backstop).** When a spec moves to `archive.d/` (fold merges), any still-non-terminal job for that slug is **cancelled** (status→completed with a clear "spec archived" reason, questions cleared) — so no orphaned paused/active item with a dead link survives. Fits naturally in `reapOrphans` ([[worker-orphan-reaper]]) or the fold-merge reconcile.
- **Box paused/failed callout tolerates a missing spec** — if a job's spec page would 404 (archived/deleted), the box links to a safe target or shows it as resolved, never a dead link (defense in depth).

## Verification
- Try to fold a spec that has a live `needs_input`/`building` job → the fold is **refused/deferred** (not archived); once the job goes terminal, the fold proceeds.
- Archive a spec (fold merges) that somehow still has a non-terminal job → that job is **auto-cancelled** with an "spec archived" reason within one reaper cycle; the box no longer shows it as paused/active.
- The box paused/failed callout never produces a 404 link (a job whose spec is archived resolves or links safely).
- Negative: a spec with only terminal jobs folds normally; a live job whose spec is NOT archived is never touched.

## Phase 1 — fold-refuses-live-build + archive-cancels-orphan-jobs ⏳
Add the live-job check to the fold path (`enqueue_fold` / auto-fold gate); cancel non-terminal jobs for a slug when it's archived (reapOrphans / fold-merge reconcile); harden the box callout against a missing spec. Brain: [[auto-ship-pipeline]] · [[worker-orphan-reaper]] · [[../libraries/roadmap-actions]] · [[../libraries/agent-jobs]] · [[../dashboard/roadmap]].
