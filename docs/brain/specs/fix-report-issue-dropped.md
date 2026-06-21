# Fix: Report Issue Silently Dropped When a Build Is Active ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — Roadmap build-console reliability (hardens [[../lifecycles/roadmap-build-console]] · [[../specs/build-approval-gates]]; supersedes the earlier `build-no-op-visibility` proposal)

**Report Issue silently discards the report when the target spec already has an active build.** `queueRoadmapBuild()` (`src/lib/roadmap-actions.ts:86–96`) enforces 'one active build per spec': if any job is in an `ACTIVE_STATUSES` state (`queued/claimed/building/needs_input/needs_approval/queued_resume`), it returns the existing job with `alreadyActive=true` and **never inserts the new instructions** — the issue text is lost, not stored anywhere. The UI (`BuildButton.tsx reportIssue()`) only checks `if (d.job)`, which is truthy on the `alreadyActive` response, so it closes the dialog, clears the text, and looks successful. Net: no build, no PR, no error, fix text gone.

## Evidence (dev-ask investigation, 2026-06-21)
- The `developer-message-center` spec had build **#153 in `building`** from 15:24→~16:34 on Jun 21. A Report Issue clicked in that window coalesced into #153 and was dropped — no job, no record anywhere.
- Coalescing is correct for a plain **Build** tap (no instructions); it is **wrong** for **Report Issue**, which carries new, distinct instructions.
- Secondary failure mode (also fix): 3 builds completed with no commit → `status=completed`, no PR, no reason (`log_tail='no file changes; nothing to commit'`).

## Phase 0 — Ship the original ask (bundled) ⏳
- `src/app/dashboard/developer/messages/MessageCenterChat.tsx` (~line 301): the composer `<textarea>` is hardcoded `rows={2}`. Enlarge: `rows={5}`, `min-h-28`, `max-h-64 overflow-auto`, auto-grow with content. UI-only, no schema. (The report that started this.)

## Phase 1 — Never drop a Report Issue (server) ⏳
- In `queueRoadmapBuild`, when `instructions` are present (a Report Issue / scoped fix) and an active build already exists for the slug: **do not coalesce-and-drop.** Enqueue a distinct follow-up `build` row (`status='queued'`, instructions preserved); the box already serializes per-spec so it runs after the active build. A plain Build tap (no instructions) keeps coalescing.
- Return a typed result that the caller can distinguish: `{ job, queuedBehindActive: true }` vs `{ job, alreadyActive: true }` vs a fresh job.
- Brain: [[../libraries/roadmap-actions]], [[../lifecycles/roadmap-build-console]] § Dispatch.

## Phase 2 — Honest UI feedback (dashboard + Slack) ⏳
- `BuildButton.tsx reportIssue()`: branch on the response. New/queued-behind-active → 'Issue queued as build <id> (will run after the current build)'. Plain `alreadyActive` with NO new job → do **not** clear+close as success; show 'A build is already running — your issue was queued to run next' (or an error if it truly couldn't queue). Mirror in the Slack `/bug` path ([[../integrations/slack-roadmap-console]]).

## Phase 3 — No-commit builds can't masquerade as done ⏳
- In `scripts/builder-worker.ts`: a build that finishes with no commit / empty diff → `status='needs_attention'` carrying the agent's `no_changes_reason` (from final JSON / `log_tail`), surfaced on the card with a Retry — never bare `completed` with no PR. Update the `build-spec` skill contract to emit `no_changes_reason` when it makes no edits.

## Verification
- [ ] Dev-message-center typing window is visibly taller (rows≥5, grows with content).
- [ ] Start a build on spec X; while it's `building`, click Report Issue on X → a SECOND `queued` job appears with your instructions stored, and the UI says it's queued to run next (no silent success, instructions never lost).
- [ ] Report Issue with no active build → normal new build + PR (positive control).
- [ ] A build that makes no changes shows `needs_attention` + reason, not `completed`-no-PR.
- [ ] Brain pages updated in the same PR.
