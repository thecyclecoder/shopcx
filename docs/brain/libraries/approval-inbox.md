# libraries/approval-inbox

The **routed-inbox emitter** — turns every [[../tables/agent_jobs]] `needs_approval` into a routed **Approval Request** in the M1 [[../dashboard/agents]] inbox, carrying the agent's investigation + proposed fix **inline** ([[../specs/approval-routing-engine]] Phase 2, the keystone of [[../goals/devops-director]]).

**File:** `src/lib/agents/approval-inbox.ts`

## Why this exists

Phase 1 shipped the pure router ([[approval-router]] `resolveApprover`) + the live flags ([[../tables/function_autonomy]]). This is the module that **uses** them: it resolves *who decides* for a raised approval and surfaces the request in that role's inbox, so the CEO reads **one inbox** instead of the N scattered surfaces ([[../dashboard/control-tower]] feeds, spec cards, the box `approvalHref`). Investigation inline = the decision is one read, no click-through. **Phase 4 retired the scattered surfaces:** the Control Tower repair/db-health feeds, the spec cards, and the box `approvalHref` now deep-link into this one inbox (`routedInboxHref()`) instead of raising their own approval cards — one inbox, no orphans.

## The single chokepoint — `reconcileApprovalInbox(admin)`

The "**one inbox, no orphans**" sweep. The box worker poll loop (`scripts/builder-worker.ts`) runs it ~every 20s. It is the one place that guarantees no approval is dropped:

- **Emit** — for every open `needs_approval` job with no routed Approval Request yet, insert one `dashboard_notifications` row (`type='agent_approval_request'`). **Idempotent** on `metadata.agent_job_id`, so a job that re-parks to `needs_approval` (resume-with-no-decision) never double-emits.
- **Dismiss** — for every live Approval Request whose job has **left** `needs_approval` (approved → `queued_resume`, declined, done, gone), set `dismissed=true`. The inbox only ever shows requests still awaiting a decision.

Catches **every** kind regardless of which surface raised it (repair / db_health / coverage-register / plan / migration-fix / storefront / build). Best-effort + bounded (≤500 jobs, ≤2000 open requests per sweep); never throws into the poll loop. Returns `{ created, dismissed }`.

## Routing — up the org chart, else the CEO

`ownerFunctionForKind(kind)` maps `agent_jobs.kind` → the owning org-chart **function** (the `agent-kind` lanes' `owner` in the Control Tower [[control-tower|registry]] — the single source of truth; `db_health` / `coverage-register` are platform crons mapped explicitly; an unknown kind ⇒ `null`). That owner feeds [[approval-router]] `resolveApprover(owner, chart, autonomy)` → the first **live+autonomous** ancestor, else the **CEO** (fail-safe: an unmapped/unconfigured tool never silently routes to a director). The resolved function is stamped on the notification's `metadata.routed_to_function`; the inbox API filters each role to the approvals routed to it.

**Goal greenlights NEVER route to a director** ([[../specs/director-proposed-goals]]). The `proposed-goal` kind is deliberately **absent** from `KIND_TO_FUNCTION` → `ownerFunctionForKind` returns `null` → `resolveApprover` falls through to the **CEO**, even when the *proposing* director is live+autonomous (a director may propose its own goal but may never greenlight any goal — its own or another's). `approvalDeepLink('proposed-goal', slug)` → `/dashboard/roadmap/goals/{slug}`; the single `greenlight_goal` action is a plain inline Approve/Decline. Do not map `proposed-goal`.

## Inline investigation + the decision

`buildApprovalContent(job)` builds the title + the **inline body** from the still-pending `pending_actions` — each action's `summary`/`spec.title`/`spec_title`, its `preview` (the agent's diagnosis), and any `cmd` (the gated command), falling back to `log_tail`. `inlineApproveActionId(job)` returns the single action id for the back-compat single-action case; **`inlineApproveActions(job)` (Phase 4) generalizes it to the whole list** — every still-pending **plain** action mapped to an `InboxApprovalAction` (`id`, `summary`, `preview`/`cmd`, and a plan branch's `specOwner`/`specParent`), so a multi-action `build` and a **multi-branch `plan`** are each decided **inline** in the inbox (one Approve/Decline per action). It returns `null` (no inline actions → the row deep-links out) when **any** pending action is multi-CHOICE (`coverage_register` register-vs-exempt, `storefront_campaign` hero reject-with-notes) — the inbox never guesses those; `approvalDeepLink(kind, …)` sends them to the canonical surface (Control Tower coverage / optimizer). The inbox API reads the still-pending list **live** off the job (not the emit-time snapshot) so a half-decided plan shows only the branches left. The decision rides the **unchanged** `POST /api/roadmap/approve` path ([[roadmap-actions]] `approveRoadmapAction` → `queued_resume`) — routing changes *where* a request surfaces, never *how* an approved action runs.

**Phase 4 — one inbox, single source.** The shared `routedInboxHref(role?)` (in `src/lib/agents/inbox.ts`) is the deep-link every **migrated** surface now points at instead of raising its own standalone approval card: the [[control-tower]] repair/db-health feeds (now read-only views), the spec-card [[roadmap|BuildButton/PlanButton]], and the box page [[roadmap|`approvalHref`]] (paused jobs → the inbox; failed jobs → their spec/surface, never the retired Control-Tower default). After migration no approval surfaces anywhere except the routed inbox (genuinely multi-choice surfaces remain only as the inbox's deep-link **targets**).

## Slack #cto-ada mirror ([[../specs/ada-slack-routed-approvals]])

A **CEO-routed** Approval Request whose workspace has `slack_ada_channel_id` set is also mirrored into `#cto-ada` as Ada (the [[slack-ada]] surface). The reconciler picks the right surface per request:

- **Card (Phase 1)** — `inlineApproveActions(job)` is non-null AND none of the chat-mode triggers fire. The card is built from `buildApprovalContent(job)` + `inlineApproveActions(job)` (same investigation body the web inbox shows inline), posted via `postAsAda`, and its `ts` stashed back on `dashboard_notifications.metadata.slack_message_ts` — the idempotency key (a re-parked job never double-posts) and the read-path key for `chat.update` (Phase 2 in-Slack tap, Phase 4 web→Slack mirror).
- **Chat-mode invitation (Phase 3)** — `shouldUseChatMode(job, row)` is true (multi-choice action, `proposed-goal` / planner `spec` kind, or a >1200-char investigation preview — `CHAT_MODE_PREVIEW_LIMIT`). Instead of a card, Ada posts a short invitation ("…paused for your call. …Want to walk through it?") and creates a [[director_coach_threads]] row via `createChatModeInvitationThread` keyed off the post's ts so a founder reply in the thread resumes the same conversation. `metadata.slack_chat_mode=true` + `coach_thread_id` are stashed alongside `slack_message_ts`.

A non-CEO routed approval, or a workspace without `slack_ada_channel_id`, short-circuits — those stay in the web inbox only.

## Phase 4 — bidirectional mirror with the web inbox

`mirrorWebDecisionToAdaSlack(admin, workspaceId, jobId, actionId, decision)` is called from [[roadmap-actions]] `approveRoadmapAction` after a terminal `approve`/`decline` so the routed Slack surface never shows stale state. It looks up the live `dashboard_notifications` row by `metadata.agent_job_id`, then forks on the surface:
- **Card** — `chat.update` from the LIVE job state; the just-decided row's tail swaps to "✅ Approved (in web inbox)" / "✕ Declined (in web inbox)" (via `InboxCardAction.decidedInWebInbox`), other pending rows stay tappable, other previously-resolved rows keep their default label.
- **Chat-mode invitation** — `postAsAda` posts a closing thread reply ("Decided in the web inbox — approved/declined. Anything to dig into?") keyed off `slack_message_ts`, so the conversation doesn't dangle.

Slack-tap callers pass `source: 'slack-inbox'` to skip the mirror (their own `updateMessage` is the canonical "applying…" render); everyone else (web inbox, slack-roadmap-console) defaults to `web` and triggers it. Best-effort: the helper swallows its own errors so a Slack outage never blocks a decision that already landed on the job.

## Exports

- **`reconcileApprovalInbox(admin)`** → `Promise<{ created, dismissed }>` — the sweep (above).
- **`ownerFunctionForKind(kind)`** → `string | null` — kind → owning function (null ⇒ unknown ⇒ CEO).
- **`buildApprovalContent(job)`** → `{ title, body }` — the inline title + investigation body.
- **`inlineApproveActionId(job)`** → `string | null` — the single plain approve/decline action, else null (back-compat).
- **`inlineApproveActions(job)`** → `InboxApprovalAction[] | null` (Phase 4) — every still-pending plain action for inline multi-action/multi-branch decisioning; `null` when any action is multi-choice.
- **`approvalDeepLink(kind, specSlug, specMissing?)`** → `string` — the canonical decide-surface fallback (multi-choice).
- **`routedInboxHref(role?)`** (in `inbox.ts`) → `string` — the `/dashboard/agents?view=inbox&role=…` deep-link every migrated surface points at (Phase 4).
- **`buildApprovalNotification(job, chart, autonomy)`** → the resolved notification row (pure given the snapshot).
- **`mirrorWebDecisionToAdaSlack(admin, workspaceId, jobId, actionId, decision)`** (Phase 4) → `Promise<void>` — mirror a non-Slack-inbox approve/decline back to the routed `#cto-ada` card or chat-mode thread.
- Type **`ApprovalJobRow`** — the `agent_jobs` columns the emitter reads.

## Safety invariants

- **Route up, never sideways/down** + **default to CEO** — inherited from [[approval-router]] `resolveApprover` (unchanged here).
- **No orphans** — the reconciler is exhaustive over `needs_approval`; a request with no resolvable approver routes to the CEO, never dropped.
- **Idempotent** — keyed on `metadata.agent_job_id`; re-parks don't duplicate.
- **Execution path unchanged** — emit only surfaces the request; `POST /api/roadmap/approve` → `queued_resume` is untouched.

## Callers

- `scripts/builder-worker.ts` (poll loop) — runs `reconcileApprovalInbox(db)` ~every 20s.
- `src/app/api/developer/agents/inbox/route.ts` — consumes the `metadata.routed_to_function` / `approve_action_id` / `deep_link` the emitter stamps.

## CEO bounce-back affordance — `POST /api/developer/agents/inbox/bounce-back`

When a director escalates a sound diagnosis the CEO inbox can render only **Dismiss** for, a **Send back to {Director}** button re-queues the same escalation to the director with the richer [[../specs/director-judgment-lanes-fold-author-dismiss|judgment-lanes verdict surface]] — letting the director land an action this time without manual CEO work. Implemented by [[director-bounce-back]] + the inbox row's `ApprovalRow` component. The endpoint is owner-gated and depth-capped at one round-trip ([[../specs/bounce-escalation-back-to-director]]).

## Related

[[../specs/approval-routing-engine]] · [[approval-router]] · [[director-bounce-back]] · [[../tables/function_autonomy]] · [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] · [[../tables/director_activity]] · [[../dashboard/agents]] · [[roadmap-actions]] · [[control-tower]] · [[../goals/devops-director]] · [[../operational-rules]]
