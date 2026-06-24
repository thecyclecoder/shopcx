# Lifecycle: Ada surfaces routed CEO approvals in #cto-ada

End-to-end trace of how a routed CEO Approval Request also shows up in `#cto-ada` (the same Slack surface as [[ada-slack-chat]]). Routine approvals get a Block Kit **Approve / Reject** card — one-tap from the founder's phone, decided through the SAME `approveRoadmapAction` the web inbox calls. Complex approvals (multi-choice, brain-touching specs, walls of diff) instead get a chat-style invitation opening a [[../tables/director_coach_threads]] thread — the founder talks it through with Ada before a decision is committed. Either way the web inbox at `/dashboard/agents?view=inbox&role=ceo` is the second surface; both stay bidirectionally in sync.

Spec: [[../specs/ada-slack-routed-approvals]] (until folded). Owner: [[../functions/platform]].

## The cast of moving parts

| Piece | Where |
|---|---|
| The reconciler — emit + dismiss + Slack mirror | [[../libraries/approval-inbox]] `reconcileApprovalInbox` (`src/lib/agents/approval-inbox.ts`) |
| `postAsAda` / `updateMessage` / `postAsAda(…, {thread_ts})` | [[../libraries/slack]] (`src/lib/slack.ts`) |
| Routed-inbox card Block Kit | `src/lib/slack-ada.ts` — `buildInboxApprovalCard` / `INBOX_ACTIONS` / `InboxCardAction` |
| Approve / Reject taps | `src/app/api/slack/interactions/route.ts` (`inbox_approve` / `inbox_reject`) |
| Chat-mode invitation thread | `createChatModeInvitationThread` in [[../libraries/director-coach-threads]] |
| Decision path (unchanged) | [[../libraries/roadmap-actions]] `approveRoadmapAction` → `agent_jobs.status='queued_resume'` |
| Web→Slack mirror | `mirrorWebDecisionToAdaSlack` (Phase 4) |
| Routing state | [[../tables/dashboard_notifications]] (`metadata.slack_message_ts` / `slack_chat_mode` / `coach_thread_id`) + [[../tables/workspaces]] (`slack_ada_channel_id`) |

## Preconditions

- The workspace has `slack_ada_channel_id` set (`/ada-here` from [[ada-slack-chat]] setup).
- The routed Approval Request resolves to the CEO (`metadata.routed_to_function === 'ceo'`). Director-routed approvals stay in the director's own queue and never enter `#cto-ada`.

## Happy path — routine routed approval (Phase 1+2)

```
agent_jobs.status flips to 'needs_approval' (any kind — build, plan, repair, db-health, …)
  → box worker poll loop calls reconcileApprovalInbox(admin) (~every 20s)
      • emit: buildApprovalNotification(job, chart, autonomy) → INSERT dashboard_notifications
        (idempotent on metadata.agent_job_id — a re-park never double-emits)
      • mirrorToAdaSlackInbox: routed_to_function === 'ceo' + workspace has slack_ada_channel_id?
          inlineApproveActions(job) → non-null + no chat-mode trigger → CARD path
          • buildInboxApprovalCard({notificationId, title, body, actions})
          • postAsAda(token, channel, blocks, text) — top-level post, NEVER threaded
            (never bury an active coach thread; never hijack one with an inbox card)
          • stash post.ts back onto dashboard_notifications.metadata.slack_message_ts
            (the read-path key for chat.update + the Phase 4 mirror)

Founder taps Approve / Reject on the card
  → POST /api/slack/interactions  (block_actions)
      • verifySlackSignature + resolveWorkspaceByTeamId
      • resolveSlackActor → isOwner — channel membership is NOT authorization
      • handleInboxDecision(action_id, value, …)
          value = JSON { notificationId, actionId }
          • look up dashboard_notifications by id → metadata.agent_job_id
          • approveRoadmapAction(workspaceId, userId, { jobId, actionId, decision, source:'slack-inbox' })
              → the SAME function the web inbox calls; leash, bundle ALL-OR-NOTHING,
                escalateApprovalRequestToCeo, ledger all inherited unchanged
              → source:'slack-inbox' skips the web→Slack mirror (Phase 4) — we update the card here
          • chat.update the card from the LIVE job state — multi-action bundles keep
            still-pending rows tappable while the just-tapped row flips to "✅ Approved — applying…"

Box worker's next poll: agent_jobs leaves 'needs_approval' (queued_resume / declined / done)
  → reconcileApprovalInbox dismisses the dashboard_notifications row (sets dismissed=true)
  → postSlackDismissConfirmation (Phase 2): postAsAda thread reply on the original card —
      "✅ Approved — PR #521 resumed." / "✕ Declined — build returned to me."
```

## Chat-mode path — complex routed approval (Phase 3)

```
The same reconciler tick, but shouldUseChatMode(job, row) fires when ANY:
  - inlineApproveActions(job) === null  (multi-choice: coverage_register / storefront_campaign)
  - job.kind === 'proposed-goal'  (the CEO never greenlights a new goal from a card tap)
  - any pending action is type:'spec'  (a planner-proposed brain commit)
  - row.body.length > CHAT_MODE_PREVIEW_LIMIT (default 1200) — wall-of-diff
  →
  • postChatModeInvitation(admin, job, row, notificationId, surface)
    • loadWorkspaceOwnerUserId — without one the events handler would reject any reply,
      so the invitation would dangle. Skip the chat-mode emit; the web inbox is still the fallback.
    • buildChatModeInvitationText(job, row) — Ada's one-line opener with a reason tailored to
      the trigger ("It's a new goal — worth talking through before I greenlight.", etc.)
    • postAsAda(token, channel, [], invitation) — top-level post, no buttons
    • createChatModeInvitationThread:
        director_coach_threads (source='slack', slack_thread_ts=post.ts, user_id=ownerUserId,
                                metadata={chat_mode:true, agent_job_id, notification_id,
                                          spec_slug, kind, investigation})
    • stash slack_message_ts + slack_chat_mode=true + coach_thread_id onto the notification

Founder replies in the thread
  → POST /api/slack/events  (event.type='message', event.thread_ts=invitation.ts)
      • channel + owner gates same as ada-slack-chat
      • findThreadBySlackThreadTs → resume the SAME director_coach_threads row
      • enqueue agent_jobs kind='director-coach' { mode:'turn', intent:'auto' }

Box runs runDirectorCoachJob:
  • the thread's metadata.chat_mode=true + agent_job_id + investigation pre-seed the box's
    context — Ada doesn't have to re-derive what they're discussing
  • intent='auto' → defaults to ASK; if the conversation reaches resolution and a durable
    change is implied, Ada emits an ada-slack-chat-style pending_action card (an Approve/Reject
    on the relevant coaching/spec/goal) — same gate, same approver, same approveRoadmapAction
    when applicable (see ada-slack-chat lifecycle)
```

## Bidirectional mirror — the two surfaces never show stale state (Phase 4)

**Slack decision → web inbox.** Phase 2's `approveRoadmapAction` call moves the underlying job out of `needs_approval`; the reconciler's next sweep dismisses the `dashboard_notifications` row, so the web inbox naturally stops showing it. No extra path.

**Web inbox decision → Slack card.** Inside `approveRoadmapAction` (`src/lib/roadmap-actions.ts`), after a terminal `approve`/`decline`, we call `mirrorWebDecisionToAdaSlack(admin, workspaceId, jobId, actionId, decision)`. The mirror:

1. Looks up the routed `dashboard_notifications` row by `metadata.agent_job_id`.
2. If `metadata.slack_message_ts` is absent ⇒ no-op (non-CEO route, or no `slack_ada_channel_id`).
3. Loads the workspace's Ada surface (channel + bot token). Either missing ⇒ no-op.
4. **Chat-mode (Phase 3 invitation):** `metadata.slack_chat_mode === true` ⇒ `postAsAda(…, {thread_ts: slack_message_ts})` a closing thread reply — *"Decided in the web inbox — approved/declined. Anything to dig into?"* — so the conversation doesn't dangle.
5. **Card (Phase 1):** rebuild from the LIVE job state and `chat.update` keyed off `slack_message_ts`. The just-decided action carries `decidedInWebInbox=true` so its tail flips to *"✅ Approved (in web inbox)"* / *"✕ Declined (in web inbox)"*; still-pending actions keep their Approve/Reject buttons; previously-decided rows keep their default label.

`approveRoadmapAction` accepts `opts.source: 'web' | 'slack-inbox'`. The in-Slack tap (`handleInboxDecision`) passes `source: 'slack-inbox'` to skip the mirror — it already `updateMessage`s the card locally without the "(in web inbox)" suffix. Every other caller (web inbox at `/api/roadmap/approve`, slack-roadmap-console approve buttons) defaults to `'web'` and triggers the mirror.

**Best-effort.** `mirrorWebDecisionToAdaSlack` wraps its work in try/catch — a Slack outage logs and returns; the decision already landed on the job and the ledger entry already wrote. `reject` (the optimizer hero reject-with-notes regen, not terminal) is skipped; only `approve`/`decline` mirror.

## Safety invariants

- **Decision path unchanged.** Slack Approve / Reject calls `approveRoadmapAction` — same gate as the web inbox. The leash, bundle ALL-OR-NOTHING, escalation, and ledger all inherit.
- **Owner-only on every tap.** Slack channel membership is not authorization — `resolveSlackActor` + `isOwner` re-check every button press; non-owners get the ephemeral "Owner-only" reply, job unchanged.
- **No persona scope expansion.** `postAsAda` is the only persona-override call; `chat:write.customize` stays scoped to `#cto-ada` (the `chat.update` path uses plain `updateMessage` and preserves the original sender identity Slack stored at post time).
- **Inbox cards are top-level, not threaded.** A routine approval can't bury an active coach thread; a coach thread can't be hijacked by an inbox card. Chat-mode invitations are also top-level, but they ARE conversation starters — replies inside them become coach turns about that one approval.
- **Idempotent.** `metadata.slack_message_ts` keys the dismiss reply + the web→Slack mirror; a re-parked job (resume-with-no-decision) never double-posts.
- **Non-CEO routed approvals stay in the dashboard.** Director-routed approvals never enter `#cto-ada` (the founder's leash check filter — only the CEO's queue Slack-mirrors).
- **`#alerts-critical` / `#daily-digest` still post as `shopcx`.** No persona leak — `postAsAda` is only ever called from the routed-inbox emit + Phase 4 mirror + [[ada-slack-chat]].

## Related

[[../specs/ada-slack-routed-approvals]] · [[../libraries/approval-inbox]] · [[../libraries/roadmap-actions]] · [[../libraries/slack]] · [[ada-slack-chat]] · [[../tables/dashboard_notifications]] · [[../tables/director_coach_threads]] · [[../dashboard/agents]] · [[../functions/platform]]

---

[[../README]] · [[../../CLAUDE]]
