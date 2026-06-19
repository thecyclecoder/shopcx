# libraries/slack-roadmap

Block Kit builders for the [[../integrations/slack-roadmap-console|Slack Roadmap Console]] — **pure rendering, no token spend**. Turns the brain roadmap + live [[../tables/agent_jobs]] into board, detail, per-job push messages, and the answer modal.

**File:** `src/lib/slack-roadmap.ts`

## Exports

- `ACTIONS` — the interaction `action_id` constants (`roadmap_build`, `roadmap_view_pr`, `roadmap_merge`, `roadmap_answer_open`, `roadmap_approve`, `roadmap_decline`, `roadmap_answer_submit`).
- `jobChip(job, fold)` — short live status chip (`🛠️ building`, `⚠️ needs input`, `✅ built — PR open`, `🗂️ Folding…`, …). Reused by [[slack-home]] for the App Home tab.
- `buildBoardBlocks({ specs, jobs, folds })` — the `/roadmap` board: **In progress / Planned / Shipped — awaiting verification** sections, one card per spec with phase emoji + chip + Build / View PR / Answer / Squash & merge buttons. Capped at 16 cards (Slack's 50-block ceiling) with a "+N more" note.
- `buildSpecDetailBlocks(spec, job, fold)` — `/roadmap <slug>` single-spec detail (phases + state + buttons).
- `buildNeedsInputMessage` / `buildNeedsApprovalMessage` / `buildCompletedMessage` / `buildFailedMessage` — per-job push/update messages.
- `buildStatusPushMessage(slug, spec, job)` — picks the right per-job message for a transition (used by the [[../inngest/slack-roadmap-notify|watcher]]); returns `null` for non-notify statuses.
- `buildAnswerModal(job, slug, origin?)` — a `modal` view rendering `agent_jobs.questions` as inputs; `callback_id = roadmap_answer_submit`, `private_metadata` carries `{ jobId, slug, channel, ts }`.

## Conventions

- Interactive elements encode their target in a JSON `value` (e.g. `{slug}`, `{jobId,actionId,decision}`, `{prNumber,slug,m:1}`). The `m:1` flag marks a **single-purpose** (non-board) message the merge handler may `updateMessage` in place — without it, a board-card merge would overwrite the whole board.
- All text is `truncate`d under Slack's 3000-char section limit.

## Callers

- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts` · `src/lib/slack-home.ts` · `src/lib/inngest/slack-roadmap-notify.ts`

## Related

[[../integrations/slack-roadmap-console]] · [[slack]] · [[slack-home]] · [[roadmap-actions]] · [[brain-roadmap]] · [[../tables/agent_jobs]]

---

[[../README]] · [[../../CLAUDE]]
