# ⏳ Ada surfaces routed CEO inbox approvals in #cto-ada

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (phone-first idea→spec→build, extended from founder↔CTO conversation to the routed approval inbox itself)

Extend the `#cto-ada` surface ([[ada-slack-chat]]) so it also mirrors the **routed CEO approval inbox** ([[../libraries/approval-inbox]]). Today, an `agent_approval_request` routed to the CEO writes a `dashboard_notifications` row and stops there — the founder sees a deep-link in the web inbox at `/dashboard/agents?view=inbox&role=ceo`, never a Slack button. After this spec, every such request also posts in `#cto-ada` as **Ada** with Block Kit Approve/Reject buttons (in a fresh thread, not threaded into an active chat). For genuinely complex requests (multi-choice plans, brain-touching specs, foundational rewrites), Ada instead posts a short chat-style invitation — "can we chat about this spec/build?" — opening a director_coach_thread so a Slack reply continues the conversation.

**Why:** the founder lives on his phone in Slack. The whole point of `#cto-ada` is to remove the trip to the dashboard for things that should be one-tap. Right now routine approvals (the bulk of the queue) still force a context switch, and complex approvals get dumped as a wall of diff that the founder shouldn't be eyeballing solo anyway — Ada knows the code better than he does. North-star fit: the gate doesn't move (every approval still rides `setActionDecision` → `approveRoadmapAction` → `queued_resume`); only the surface does. Ada is still the supervised tool — the leash is unchanged, the human still decides.

## Phase 1 — Slack emit from the routed-inbox reconciler
- ⏳ planned
- In `reconcileApprovalInbox(admin)` (`src/lib/agents/approval-inbox.ts`): after inserting the new `dashboard_notifications` row, if `metadata.routed_to_function === 'ceo'` AND the workspace has `slack_ada_channel_id` set, post a Block Kit card in `#cto-ada` as Ada via `postAsAda`.
- **Idempotency:** stash the posted message `ts` back on the `dashboard_notifications.metadata.slack_message_ts` so the reconciler's dismiss pass + Phase 4 mirror can `chat.update` it. The reconciler only emits a Slack post when `slack_message_ts` is absent (re-parking a job doesn't double-post).
- **Threading:** **never** thread into an existing #cto-ada chat thread — these are inbox items, not conversation turns. Each approval is its own top-level post, so a routine approval doesn't bury the active coach thread and a coach thread doesn't get hijacked by an unrelated build pause.
- **Card content:** the card is built from `buildApprovalContent(job)` + `inlineApproveActions(job)` (the same investigation body the web inbox shows inline). Title, the agent's preview/diagnosis, and one row of Approve / Reject buttons per still-pending plain action. `action_id`s `inbox_approve` / `inbox_reject` (distinct from `ada_approve`/`ada_reject` so the handler can dispatch correctly); button `value` = JSON `{ notificationId, actionId }`.
- **Multi-choice → no buttons.** When `inlineApproveActions(job)` returns `null` (any action is multi-choice, the Phase 3 case), skip the Block Kit card entirely and emit a Phase 3 chat-mode invitation instead.

## Phase 2 — Block Kit Approve / Reject wired to the existing path
- ⏳ planned
- `src/app/api/slack/interactions/route.ts`: add `block_actions` handlers for `inbox_approve` / `inbox_reject`.
- **Re-gate:** the tapping Slack user must map to an `owner` `workspace_member` (reuse `resolveSlackActor` / `isOwner`). Channel membership is not authorization. Same gate the web inbox enforces.
- **Decision path is unchanged:** Approve → `approveRoadmapAction(workspaceId, jobId, actionId, 'approve')`. Reject → `'decline'`. **No new mutation code.** Same call the `/api/agents/inbox/decide` route makes — the leash, the bundle ALL-OR-NOTHING rule, every safety invariant is inherited unchanged.
- `chat.update` the card (its stored `ts`) → replace the buttons with "✅ Approved — applying…" / "✕ Declined". When the underlying `agent_jobs` row moves out of `needs_approval`, the reconciler dismisses the `dashboard_notifications` row and posts a one-line confirmation in the same thread ("Done — PR #521 resumed." / "Declined — build returned to me.").

## Phase 3 — Chat-mode for complex approvals ("can we chat about this?")
- ⏳ planned
- A routed approval qualifies for **chat-mode** when ANY of:
  - `inlineApproveActions(job)` returns `null` (any pending action is multi-choice — `coverage_register`, `storefront_campaign` hero reject-with-notes, or a `plan` with multiple branches).
  - The job's `kind` is in a **brain-touching** set: `spec` (a foundational spec build), `proposed-goal`, anything emitting a `directive` or `goal` action.
  - The investigation preview exceeds N characters (default: 1200) — blind-approving a wall of diff is the failure mode.
- For these, instead of an Approve/Reject card, Ada posts a short chat-style invitation in a new #cto-ada thread:
  > "PR #521 (spec-status-db-driven Phase 1) paused for your call. It's foundational — touches every status reader/writer. Reversible (migration is additive, readers fall back), but worth talking through before I greenlight. Want to walk through it?"
  - The post itself **creates a `director_coach_threads` row** (`source='slack'`, `slack_channel_id`, `slack_thread_ts = the post's ts`, `created_by` = the founder's mapped user_id) so a Slack reply in that thread becomes a regular coach turn (the existing Phase 3 events handler picks it up — no new path).
  - The thread is **pre-seeded** with context: the `agent_jobs.id`, the `notification_id`, the spec slug, and Ada's read of the investigation. So when the founder replies "yeah let's talk", the box session resumes already knowing what they're discussing.
  - The chat-mode invitation **also emits a normal `agent_approval_request`** under the hood (or rather, doesn't change that emit) — the web inbox row still exists, deep-linking to the routed inbox. The founder can decide there if they prefer; the Slack thread is the opt-in conversational surface.
  - Decision happens **inside the thread** — either Ada posts an Approve/Reject card after the conversation reaches resolution (a `pending_action` she emits during a turn, already supported by [[ada-slack-chat]] Phase 5), or the founder decides in the web inbox and the thread mirrors it (Phase 4).

## Phase 4 — Bidirectional mirror with the web inbox
- ⏳ planned
- **Slack decision → web inbox:** Approving/rejecting in Slack already moves the underlying job out of `needs_approval` (Phase 2 reuses `approveRoadmapAction`); the reconciler's dismiss pass flips `dashboard_notifications.dismissed=true` on the next sweep. So the web inbox naturally stops showing it.
- **Web inbox decision → Slack card:** when the `/api/agents/inbox/decide` route runs (or any path that calls `approveRoadmapAction`), check the `dashboard_notifications` row for a `metadata.slack_message_ts`; if present, `chat.update` the Slack card to "✅ Approved (in web inbox)" / "✕ Declined (in web inbox)". This requires threading the `notification_id` (or looking it up by `agent_job_id`) through the decide route.
- **Chat-mode parity:** if the underlying job is decided externally while a chat-mode thread is open, post a short Ada note in the thread ("Decided in the web inbox — declined. Anything to dig into?") so the conversation doesn't dangle.

## Phase 5 — Brain pages (CLAUDE.md hard rule)
- ⏳ planned
- New `lifecycles/ada-slack-routed-approvals.md` — end-to-end trace: routed inbox emit → Slack card OR chat-mode thread → button tap / chat turn → approveRoadmapAction → dismiss + chat.update.
- Update `libraries/approval-inbox.md` — the Phase 1 Slack emit branch, the `slack_message_ts` metadata key, the chat-mode dispatch rule.
- Update `libraries/slack.md` / `integrations/slack.md` — the `inbox_approve` / `inbox_reject` action_ids.
- Update `tables/dashboard_notifications.md` — the `metadata.slack_message_ts` field (Phase 1 stash).
- Update `tables/director_coach_threads.md` — chat-mode threads carry the pre-seeded `agent_job_id` / `notification_id` context.
- Cross-link and run `brain:index`.

## Safety / invariants
- **Decision path is unchanged.** Slack Approve / Reject calls `approveRoadmapAction` — the same function the web inbox calls. The leash, the bundle ALL-OR-NOTHING rule, `escalateApprovalRequestToCeo`, every safety invariant is inherited. This spec adds a surface, not a new gate.
- **Owner-only, re-checked on every surface.** Slack channel membership is not authorization. The interactions route reverifies the email-mapped owner on every button tap.
- **No new Ada persona scope.** Reuses `postAsAda` from `ada-slack-chat` — chat:write.customize stays scoped to that one channel.
- **Inbox approval cards are top-level, not threaded.** Approvals don't bury active coach threads, and coach threads don't get hijacked by unrelated build pauses. Chat-mode (Phase 3) does create a new thread, but that thread IS the conversation about that one approval — its own context.
- **Idempotent.** The reconciler keys on `dashboard_notifications.metadata.slack_message_ts`; a re-parked job never double-posts.
- **Non-CEO routed approvals don't post to Slack.** Approvals routed to a director (live+autonomous, in-leash) stay in the director's own queue and don't enter #cto-ada — only CEO-routed ones do (`metadata.routed_to_function === 'ceo'`).
- **Plain text, no markdown** in Ada's prose. Block Kit only for cards.

## Completion criteria
- A build paused for CEO approval (e.g. another spec-status-db-driven-style PR) shows up in #cto-ada within ~20s of `reconcileApprovalInbox`'s next sweep — as a top-level Ada post, with the agent's investigation body and Approve / Reject buttons. Tapping Approve resumes the job; tapping Reject declines it. Both flip the card to "✅ Approved" / "✕ Declined" and dismiss the matching web inbox row.
- A complex approval (a `proposed-goal`, a multi-choice `plan`, a brain-touching spec, or a >1200-char preview) shows up as a chat-style invitation in a new #cto-ada thread, NOT as a blind Approve/Reject card. A founder reply in that thread becomes a coach turn (`source='slack'`) with the approval context pre-seeded. The web inbox row still exists as a deep-link.
- Deciding the same approval in the web inbox flips the matching Slack card (or posts a closing note in the chat-mode thread) — the two surfaces never show stale state.
- A non-owner workspace member in #cto-ada tapping Approve is rejected; only the founder's email-mapped `owner` Slack user can decide.
- The reconciler is still idempotent — re-parking a job (resume-with-no-decision) doesn't double-post a Slack card.
- `#alerts-critical` and `#daily-digest` still post as "shopcx" (persona override didn't leak).

## Verification
- Trigger a build that pauses for CEO approval (or replay an existing one). Within ~20s, expect a new top-level #cto-ada post authored as Ada, with the investigation body + Approve / Reject. Tap Approve → expect the card to flip to "✅ Approved — applying…", the job to resume (`agent_jobs.status` moves to `queued_resume`), the `dashboard_notifications` row to dismiss on the next sweep, and a one-line confirmation in the same thread.
- Trigger a `proposed-goal` from a director. Expect a chat-style invitation in #cto-ada ("want to talk through this goal?"), NOT an Approve/Reject card. Reply in the thread → expect a coach turn that resumes with the goal context already loaded (check `director_coach_threads.metadata.agent_job_id`).
- Approve an item in the web `/dashboard/agents?view=inbox&role=ceo` that originated as a Slack-card → expect the Slack card to `chat.update` to "✅ Approved (in web inbox)".
- Approve as a non-owner Slack user → expect a 403 / ephemeral "only the founder can decide here" reply, the job unchanged.
- Re-park a job (decline an approve_action that leaves it pending again) → expect no second Slack post.
- Run a normal critical-ops alert → expect it to still post as "shopcx" in `#alerts-critical`, never as Ada.
