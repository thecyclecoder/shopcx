# Fix: Report Issue Silently Dropped When a Build Is Active ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — Roadmap build-console reliability (hardens [[../lifecycles/roadmap-build-console]] · [[../specs/build-approval-gates]]; supersedes the earlier `build-no-op-visibility` proposal)

**Report Issue silently discards the report when the target spec already has an active build.** `queueRoadmapBuild()` (`src/lib/roadmap-actions.ts:86–96`) enforces 'one active build per spec': if any job is in an `ACTIVE_STATUSES` state (`queued/claimed/building/needs_input/needs_approval/queued_resume`), it returns the existing job with `alreadyActive=true` and **never inserts the new instructions** — the issue text is lost, not stored anywhere. The UI (`BuildButton.tsx reportIssue()`) only checks `if (d.job)`, which is truthy on the `alreadyActive` response, so it closes the dialog, clears the text, and looks successful. Net: no build, no PR, no error, fix text gone.

## Evidence (dev-ask investigation, 2026-06-21)
- The `developer-message-center` spec had build **#153 in `building`** from 15:24→~16:34 on Jun 21. A Report Issue clicked in that window coalesced into #153 and was dropped — no job, no record anywhere.
- Coalescing is correct for a plain **Build** tap (no instructions); it is **wrong** for **Report Issue**, which carries new, distinct instructions.
- Secondary failure mode (also fix): 3 builds completed with no commit → `status=completed`, no PR, no reason (`log_tail='no file changes; nothing to commit'`).

## Phase 0 — Ship the original ask (bundled) ✅
- `src/app/dashboard/developer/messages/MessageCenterChat.tsx`: the composer `<textarea>` was hardcoded `rows={2}`. Now `rows={5}`, `min-h-28 max-h-64 overflow-auto`, and auto-grows with content via a `composerRef` + a `useEffect` keyed on `input` (height reset to `auto` then set to `scrollHeight`). UI-only, no schema. (The report that started this.)

## Phase 1 — Never drop a Report Issue (server) ✅
- In `queueRoadmapBuild` (`src/lib/roadmap-actions.ts`), when `instructions` are present (a Report Issue / scoped fix) and an active build already exists for the slug, it no longer coalesce-and-drops: it inserts a distinct follow-up `build` row (`status='queued'`, instructions preserved); the box serializes per-spec so it runs after the active build. A plain Build tap (no instructions) still coalesces (`alreadyActive`).
- Return type now distinguishes: `{ job, queuedBehindActive: true }` vs `{ job, alreadyActive: true }` vs a fresh job. `POST /api/roadmap/build` passes `queuedBehindActive` through.
- Brain: [[../libraries/roadmap-actions]], [[../lifecycles/roadmap-build-console]] § Dispatch.

## Phase 2 — Honest UI feedback (dashboard + Slack) ✅
- `BuildButton.tsx reportIssue()` branches on the response: `queuedBehindActive` → keeps the dialog open with "Issue queued as build <id8> — it'll run after the current build finishes" (clears the text, refreshes); a fresh job → closes as before; `alreadyActive`-with-no-new-job or a non-OK response → an `issueNotice` line, NOT a phantom close. The **Report issue** button + dialog are now available *during an active build* (Build/Rebuild + Mark-verified stay `!active`), so the founder can actually report mid-build; the dialog label reflects the active state.
- Slack mirrors: `/bug` (events route) and the per-phase build (interactions route) both surface `queuedBehindActive` with the new job's short id ([[../integrations/slack-roadmap-console]]).

## Phase 3 — No-commit builds can't masquerade as done ✅
- `scripts/builder-worker.ts`: in the build `completed` path, when the worktree is clean **and there is no PR**, the job flips to `status='needs_attention'` carrying the agent's `no_changes_reason` (falls back to `summary`, then a default) instead of a bare `completed` with no PR. The card shows **Rebuild** (retry) since `needs_attention` isn't an active status. The `!dirty` + existing-PR path (resume after migration) still completes normally. `parseStatus` now carries `no_changes_reason`; the build prompt + `build-spec` skill contract instruct emitting it on a no-edit build.

## Verification
- On `/dashboard/developer` Message Center, the composer textarea shows ≥5 rows and grows as you type a long message (up to ~max-h-64, then scrolls) → expect a visibly taller box than the old 2-row one.
- On `/dashboard/roadmap`, start a build on spec X; while its chip is `Building…`, click **Report issue** on X, type a fix, **Queue fix** → expect a SECOND `queued` `agent_jobs` row for X with your `instructions` stored, and the dialog shows "Issue queued as build <id8> — it'll run after the current build finishes" (no silent close, instructions never lost).
- On `/dashboard/roadmap`, click **Report issue** on a spec with NO active build → expect a fresh `queued` build that proceeds to a `claude/*` PR (positive control).
- In Slack, `/bug <slug> <desc>` while a build is active for `<slug>` → expect an ephemeral "already has an active build — queued your fix as build `<id8>` to run next (nothing dropped)" and a second `queued` row.
- On the build box, a build that makes zero file edits → expect the job to land `needs_attention` with `error` = the `no_changes_reason` and the card to offer Rebuild — NOT `completed` with no PR. (A no-edit resume that already has a PR still completes.)
- Brain pages ([[../libraries/roadmap-actions]], [[../lifecycles/roadmap-build-console]], [[../integrations/slack-roadmap-console]]) updated in the same PR.
