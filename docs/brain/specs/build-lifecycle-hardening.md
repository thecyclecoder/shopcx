# Build-lifecycle hardening — auto-un-draft on completion + no migration re-request loops ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

Two rough edges surfaced draining the 2026-06-18 backlog (see [[fold-build-batching]], [[parallel-builds]]): a build that **paused then completed** left its PR a draft (unmergeable), and a build **re-requested a migration that was already applied** (needs_approval loop). Both forced manual intervention. Harden the worker + build protocol so a clean build goes straight to a mergeable PR with no human babysitting.

## Phase 1 — Reliable un-draft on completion ⏳
- ⏳ A build that paused (`needs_input`/`needs_approval`) opens its PR as a **draft**; on the **resume → completed** path the worker's `markReady()` (GraphQL `markPullRequestReadyForReview`) must reliably un-draft it. Observed: PR#75/#76 stayed draft and had to be un-drafted by hand.
- ⏳ Diagnose why it silently no-ops (the `catch` swallows errors — likely a GraphQL error/timing): **log the failure** instead of swallowing, and **retry once**. Confirm the PR's `node_id` is fetched after the final push.
- ⏳ Belt-and-suspenders: on completion, if the PR still reports `isDraft`, retry `markReady` before flipping the job to `completed`.

## Phase 2 — No re-request of an already-satisfied migration ⏳
- ⏳ On a resume, the build re-emitted the same `apply_migration` it had already gotten executed → `needs_approval` loop (had to mark it `done` manually). The resume prompt already reports "Gated actions executed: …" — make the build **treat an executed/done action as settled** and not re-request it.
- ⏳ `build-spec` / `write-migration` skill: **before** requesting `apply_migration` approval, **probe** whether the change already exists (the `probe-db` skill — table/column present) and **skip the request** if so. Apply-scripts are already idempotent; the goal is to stop the *loop*, not the apply.
- ⏳ Worker safety net: if a resumed build re-requests an action whose `cmd` matches one already `done` on the job, auto-mark it `done` (don't re-pause for the owner).

## Safety / invariants
- No behavior change to the approval gate for genuinely new prod actions — only de-duplicates already-executed ones and fixes draft state.
- Touches `scripts/builder-worker.ts` + the `build-spec`/`write-migration` skills → **infra build, serialize** (one worker-touching build in flight; see [[fold-build-batching]]).

## Completion criteria
- A build that pauses then completes opens a **non-draft, mergeable** PR with no manual un-draft.
- A resumed build never re-pauses on an action it already had executed; an already-applied migration is detected and skipped.

## Related
[[fold-build-batching]] · [[parallel-builds]] · [[build-approval-gates]] · [[roadmap-build-console]] · [[../recipes/build-box-setup]] · [[../lifecycles/roadmap-build-console]]
