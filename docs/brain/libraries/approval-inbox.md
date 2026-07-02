# libraries/approval-inbox

The **routed-inbox emitter** — turns every [[../tables/agent_jobs]] `needs_approval` into a routed **Approval Request** in the M1 [[../dashboard/agents]] inbox, carrying the agent's investigation + proposed fix **inline** ([[../specs/approval-routing-engine]] Phase 2, the keystone of [[../goals/devops-director]]).

**File:** `src/lib/agents/approval-inbox.ts`

## Why this exists

Phase 1 shipped the pure router ([[approval-router]] `resolveApprover`) + the live flags ([[../tables/function_autonomy]]). This is the module that **uses** them: it resolves *who decides* for a raised approval and surfaces the request in that role's inbox, so the CEO reads **one inbox** instead of the N scattered surfaces ([[../dashboard/control-tower]] feeds, spec cards, the box `approvalHref`). Investigation inline = the decision is one read, no click-through. **Phase 4 retired the scattered surfaces:** the Control Tower repair/db-health feeds, the spec cards, and the box `approvalHref` now deep-link into this one inbox (`routedInboxHref()`) instead of raising their own approval cards — one inbox, no orphans.

## The single chokepoint — `reconcileApprovalInbox(admin)`

The "**one inbox, no orphans**" sweep. The box worker poll loop (`scripts/builder-worker.ts`) runs it ~every 20s. It is the one place that guarantees no approval is dropped:

- **Emit** — for every open `needs_approval` job with no routed Approval Request yet, insert one `dashboard_notifications` row (`type='agent_approval_request'`). **Idempotent** on `metadata.agent_job_id`, so a job that re-parks to `needs_approval` (resume-with-no-decision) never double-emits.
- **Dismiss** — for every live Approval Request whose job has **left** `needs_approval` (approved → `queued_resume`, declined, done, gone), set `dismissed=true`. The inbox only ever shows requests still awaiting a decision.

Catches **every** kind regardless of which surface raised it (repair / db_health / coverage-register / plan / migration-fix / storefront / build). Best-effort + bounded (≤500 jobs, ≤2000 open requests per sweep); never throws into the poll loop. Returns `{ created, dismissed, parksCleared }`.

## One card per parked job — DEDUP + AUTO-CLEAR

A `needs_approval` job is the routed-approval path above. A `needs_attention` **park** is a *different* path with **three** distinct emitters (all keyed on `metadata.job_id`, not `agent_job_id`), so a single parked job historically inflated the CEO inbox to 2–3 cards (the migration-fix `b1a80b2d` 9-item bottleneck = ~4 real issues × duplicate cards):

| Emitter | Card | Where |
|---|---|---|
| triage ([[platform-director]] `reconcileNeedsAttention`) | `Parked {kind}: {slug}` (`agent_approval_request`, `escalation_kind=needs_attention`, dedupe `needsattn:{job}`) | non-build QC parks |
| backstop ([[needs-attention-route]] `routeBackstop` a) | `Park needs eyes: {slug}` (`agent_approval_request`, `escalation_kind=park_backstop`, dedupe `parkbackstop:{job}`) | a park `unknown` >60 min |
| age alarm ([[needs-attention-route]] `routeBackstop` b) | `Parked > 70 min: {slug}` (`type='system'`, `metadata.kind=no_parked_specs_invariant`, dedupe `parkalarm:{job}`) | a park >70 min |

**Invariant — a parked `agent_jobs` row surfaces AT MOST ONE active CEO card.** Each emitter (plus the design-change chat invite in `routeDesignChange`) gates on **`activeParkCardExistsForJob(admin, workspaceId, jobId)`** *before* inserting — a non-dismissed notification carrying this job id under **either** `metadata.agent_job_id` OR `metadata.job_id` (`notifJobId(metadata)` resolves whichever). Whichever emitter fires first wins (triage runs before route in the standing pass; for build parks triage is skipped so the route's richer chat-invite / "Park needs eyes" wins); the rest skip. The per-emitter `dedupe_key` still prevents *self*-duplication; `activeParkCardExistsForJob` is the **cross-emitter** gate that collapses the trio.

**AUTO-CLEAR stale parks — `reconcileStaleParkCards(admin)`** (run every tick inside `reconcileApprovalInbox`, even on the needs_approval read-bail path since it reads its own sources). Dismisses an active park card the moment its reason is genuinely gone. **Conservative — only clears on a definitively-resolved reason; a real failing spec-test / genuine needs_human stays.** Two families:

- **Job-backed park cards** (triage / backstop / age alarm / design-change — carry `metadata.job_id`): dismiss when the `agent_jobs` row is **gone or no longer `needs_attention`** (resolved / dismissed / re-queued — e.g. pr-878 after the resolver fix), OR it's still parked but its **spec is `folded`** (the CEO folded it as superseded). A merely-`shipped`-by-rollup spec whose job is still parked is **NOT** cleared on status alone (protects a genuine spec-test park on a shipped spec).
  - **pr-resolve parks** ([[../specs/pr-resolve-park-clears-on-pr-merged]]) don't fit the folded-spec branch — the `pr-N` slug a [[github-pr-resolve]] `surfaceExhaustedPrResolve` sentinel carries is *synthetic* (there is no real `public.specs` row to fold). So a still-parked pr-resolve job (`kind='pr-resolve'`) additionally reconciles against its PR's LIVE GitHub state via [[github-pr-resolve]] `getPr(pr_number)`: if the PR is **merged** or **closed** on GitHub (`pr.merged || pr.state !== 'open'`), the two-step done by hand for pr-1010 on 2026-07-02 runs automatically — flip the sentinel job off `needs_attention` → `completed` (with a `log_tail` breadcrumb) AND `dismissParkCard` the notification. The decision is factored into the pure exported helper **`prResolveParkOutcome(pr)`** so the SAFETY predicate is unit-testable end-to-end. CONSERVATIVE: on a failed GitHub read (`getPr` returns `{ok:false}` — no token, non-2xx, network throw) the helper returns `{action:'keep',reason:'read_failed'}` → we never clear on a null; a still-open PR keeps its card. See [[approval-inbox-pr-resolve-park.test.ts]] for the 5 cases (merged / closed / still_open / read_failed / merged-flag-wins-over-state). **Tenant-bound (per [[../specs/bind-pr-resolve-reconcile-transition]]):** the `agent_jobs` read carries `workspace_id`; a card whose `workspace_id` doesn't match the job's is refused (bogus/spoofed cross-workspace binding). The flip is a **conditional transition** scoped to (`id`, `workspace_id`, `kind='pr-resolve'`, `spec_slug='pr-<N>'`, `pr_number`, `status='needs_attention'`) returning the updated row via `.select().maybeSingle()`; if the row already raced off `needs_attention` (or any binding shifted) the transition matches zero rows and `dismissParkCard` never fires — the card stays live for a human.
- **Reva "Ambiguous post-deploy signal" cards** (`escalation_kind=deploy_unsure`, no agent_job — keyed on `metadata.spec_slug` + `deploy_watch_id`, from [[deploy-guardian]]): dismiss when the spec has since shipped/**folded** clean **AND** `deployWindowIsClean` confirms no NEW (non-baseline) `error_events` landed in the deploy's canary window. Both must hold — a fresh in-window error keeps the card. `deployWindowIsClean` fails **closed** (a missing watch / read error keeps the card).

Idempotent, logged (`[approval-inbox] auto-cleared stale park card …`), and it **never touches routed Approval Requests** (those have no `escalation_kind` / park `metadata.kind` and are owned by the needs_approval dismiss loop above).

## Routing — up the org chart, else the CEO

`ownerFunctionForKind(kind)` maps `agent_jobs.kind` → the owning org-chart **function** (the `agent-kind` lanes' `owner` in the Control Tower [[control-tower|registry]] — the single source of truth; `db_health` / `coverage-register` are platform crons mapped explicitly; an unknown kind ⇒ `null`). That owner feeds [[approval-router]] `resolveApprover(owner, chart, autonomy)` → the first **live+autonomous** ancestor, else the **CEO** (fail-safe: an unmapped/unconfigured tool never silently routes to a director). The resolved function is stamped on the notification's `metadata.routed_to_function`; the inbox API filters each role to the approvals routed to it.

**Goal greenlights NEVER route to a director** ([[../specs/director-proposed-goals]]). The `proposed-goal` kind is deliberately **absent** from `KIND_TO_FUNCTION` → `ownerFunctionForKind` returns `null` → `resolveApprover` falls through to the **CEO**, even when the *proposing* director is live+autonomous (a director may propose its own goal but may never greenlight any goal — its own or another's). `approvalDeepLink('proposed-goal', slug)` → `/dashboard/roadmap/goals/{slug}`; the single `greenlight_goal` action is a plain inline Approve/Decline. Do not map `proposed-goal`.

**Founder-prompted out-of-leash actions NEVER route to a director** ([[../specs/ceo-authorized-out-of-leash-actions]]). The `ceo-authorized-out-of-leash` kind is likewise **absent** from `KIND_TO_FUNCTION` → the request always routes to the **CEO** (a director never authorizes her own out-of-leash action). Raised by Ada from the [[director-coach-threads|Ask-Ada chat]] via `applyOutOfLeashRequestActionInline` when she independently AGREES a founder-prompted ad-hoc ask outside her leash is sound; carries her reasoning inline + a concrete executable pending-action (`run_prod_script` or `apply_migration`) with `out_of_leash: true` + `authorized_by: 'ceo-pending'` markers. The pending action's `preview` ALWAYS includes the exact command line (`$ ${cmd}`) — if preview length exceeds 4000 chars, trailing user-supplied detail is truncated but the command is always re-appended so the byte-identical cmd is never lost. The CEO approvals card defensively re-renders the cmd even if already in preview, guaranteeing visibility via `a.outOfLeash` flag (Phase 1, verified 2026-07-02). On CEO decision the unchanged `/api/roadmap/approve` gate ([[roadmap-actions]] `approveRoadmapAction`) flips each action `approved`/`declined` and the job to `queued_resume`; Phase 2 wires the resume through `runCeoAuthorizedOutOfLeashJob` ([[platform-director]] § Founder-prompted out-of-leash actions Phase 2) which shell-executes an approved `run_prod_script`/`apply_migration` via `shAsync` (same executor shape a build resume uses for its gated actions) and writes ONE `executed_ceo_authorized_out_of_leash` / `ceo_declined_out_of_leash_request` [[../tables/director_activity]] row — a SCOPED, ONE-TIME, `authorized_by='ceo'`-stamped authorization; the leash config ([[../tables/function_autonomy]]) is UNTOUCHED, so the next out-of-leash ask needs its own CEO approval.

**A `plan` (goal-decomposition) approval routes by its GOAL's owner, NOT the planner's function** (`routingOwnerForJobAsync`). The planner (Pia) is a **platform**-supervised tool, but the approval it parks is *about* the goal it decomposed — the proposed specs are owned by the goal's `owner`, not the planner. Routing it by `ownerFunctionForKind('plan')` (= `platform`, the `agent:plan` lane's owner) landed it in Ada's inbox, where a goal owned by another department (e.g. `growth`) was out of her leash **and** the CEO's card had no Approve button (it was routed to Ada). So for a `plan` job, `routingOwnerForJobAsync(admin, job)` reads `goals.owner` keyed by `job.spec_slug` (the plan job's `spec_slug` **is** the goal slug, per `/api/roadmap/plan`) and feeds *that* to `resolveApprover`: a live+autonomous owner-director approves its own plan; otherwise the keystone fail-safe routes it to the **CEO** (matching the goal page's "await YOUR approval"). A missing goal/owner falls back to the kind default → CEO via fail-safe — never a silent wrong-director auto-approve. This is async (a DB read), so the **reconciler** resolves it per job and passes the override into `buildApprovalNotification(job, chart, autonomy, ownerFnOverride?)`. The same `routingOwnerForJobAsync` keeps the ledger/Slack-mirror routing ([[roadmap-actions]] `approveRoadmapAction`) and the Platform auto-approve gates ([[platform-director]] `routesToPlatformForJob`, used by the enqueuer + the box re-confirm) in lockstep — a plan whose goal isn't platform-owned is never picked up by Ada's auto-approve sweep. Every **other** kind routes by `routingOwnerForJob` exactly as before.

The CEO's plan card needs **no special render path**: once routing puts the plan in the CEO's escalated lane and `inlineApproveActions(job)` returns its `type:'spec'` branch actions (each carries an `id`), the [[approvals-feed]] marks it `actionable` and the dashboard renders one inline **Approve** per branch. Approving them flips each action `approved` → the job to `queued_resume`, and the box `runPlanJob` **resume** authors the specs to `public.specs` + binds each `milestone_id` + queues their builds — the unchanged apply path.

## Inline investigation + the decision

`buildApprovalContent(job)` builds the title + the **inline body** from the still-pending `pending_actions` — each action's `summary`/`spec.title`/`spec_title`, its `preview` (the agent's diagnosis), and any `cmd` (the gated command), falling back to `log_tail`. `inlineApproveActionId(job)` returns the single action id for the back-compat single-action case; **`inlineApproveActions(job)` (Phase 4) generalizes it to the whole list** — every still-pending **plain** action mapped to an `InboxApprovalAction` (`id`, `summary`, `preview`/`cmd`, and a plan branch's `specOwner`/`specParent`), so a multi-action `build` and a **multi-branch `plan`** are each decided **inline** in the inbox (one Approve/Decline per action). It returns `null` (no inline actions → the row deep-links out) when **any** pending action is multi-CHOICE (`coverage_register` register-vs-exempt, `storefront_campaign` hero reject-with-notes) — the inbox never guesses those; `approvalDeepLink(kind, …)` sends them to the canonical surface (Control Tower coverage / optimizer). The inbox API reads the still-pending list **live** off the job (not the emit-time snapshot) so a half-decided plan shows only the branches left. The decision rides the **unchanged** `POST /api/roadmap/approve` path ([[roadmap-actions]] `approveRoadmapAction` → `queued_resume`) — routing changes *where* a request surfaces, never *how* an approved action runs.

**Phase 4 — one inbox, single source.** The shared `routedInboxHref(role?)` (in `src/lib/agents/inbox.ts`) is the deep-link every **migrated** surface now points at instead of raising its own standalone approval card: the [[control-tower]] repair/db-health feeds (now read-only views), the spec-card [[roadmap|BuildButton/PlanButton]], and the box page [[roadmap|`approvalHref`]] (paused jobs → the inbox; failed jobs → their spec/surface, never the retired Control-Tower default). After migration no approval surfaces anywhere except the routed inbox (genuinely multi-choice surfaces remain only as the inbox's deep-link **targets**).

## Slack #cto-ada mirror ([[../lifecycles/ada-slack-routed-approvals]])

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

- **`reconcileApprovalInbox(admin)`** → `Promise<{ created, dismissed, parksCleared }>` — the sweep (above); also runs `reconcileStaleParkCards`.
- **`reconcileStaleParkCards(admin)`** → `Promise<number>` — auto-clear obsolete park cards (job left needs_attention / spec folded / pr-resolve PR merged-or-closed on GitHub / Reva signal resolved). Count cleared.
- **`prResolveParkOutcome(pr)`** → `{action:'clear',outcome:'merged'|'closed'} | {action:'keep',reason:'read_failed'|'still_open'}` — pure decision helper: given `getPr`'s outcome, should the pr-resolve park card auto-clear? Fail-CLOSED on a null read.
- **`activeParkCardExistsForJob(admin, workspaceId, jobId)`** → `Promise<boolean>` — the one-card-per-park DEDUP gate every park emitter calls before inserting.
- **`notifJobId(metadata)`** → `string | null` — the job id off `metadata.agent_job_id` ?? `metadata.job_id`.
- **`ownerFunctionForKind(kind)`** → `string | null` — kind → owning function (null ⇒ unknown ⇒ CEO).
- **`routingOwnerForJob(job)`** → `string | null` — sync routing owner (model-tier target kind; else the job's kind).
- **`routingOwnerForJobAsync(admin, job)`** → `Promise<string | null>` — async routing owner; a `plan` job resolves to its **goal's** owner (`goals.owner` keyed by `job.spec_slug`), else delegates to `routingOwnerForJob`.
- **`resolveGoalOwnerFunction(admin, workspaceId, goalSlug)`** → `Promise<string | null>` — a goal's owner function from `public.goals`.
- **`buildApprovalContent(job)`** → `{ title, body }` — the inline title + investigation body.
- **`inlineApproveActionId(job)`** → `string | null` — the single plain approve/decline action, else null (back-compat).
- **`inlineApproveActions(job)`** → `InboxApprovalAction[] | null` (Phase 4) — every still-pending plain action for inline multi-action/multi-branch decisioning; `null` when any action is multi-choice.
- **`approvalDeepLink(kind, specSlug, specMissing?)`** → `string` — the canonical decide-surface fallback (multi-choice).
- **`routedInboxHref(role?)`** (in `inbox.ts`) → `string` — the `/dashboard/agents?view=inbox&role=…` deep-link every migrated surface points at (Phase 4).
- **`buildApprovalNotification(job, chart, autonomy, ownerFnOverride?)`** → the resolved notification row (pure given the snapshot; the reconciler passes the async-resolved goal owner as `ownerFnOverride` for a `plan` job).
- **`mirrorWebDecisionToAdaSlack(admin, workspaceId, jobId, actionId, decision)`** (Phase 4) → `Promise<void>` — mirror a non-Slack-inbox approve/decline back to the routed `#cto-ada` card or chat-mode thread.
- Type **`ApprovalJobRow`** — the `agent_jobs` columns the emitter reads.

## Safety invariants

- **Route up, never sideways/down** + **default to CEO** — inherited from [[approval-router]] `resolveApprover` (unchanged here).
- **No orphans** — the reconciler is exhaustive over `needs_approval`; a request with no resolvable approver routes to the CEO, never dropped.
- **Idempotent** — keyed on `metadata.agent_job_id`; re-parks don't duplicate.
- **One card per parked job** — every park emitter gates on `activeParkCardExistsForJob`; a parked `agent_jobs` row surfaces ≤1 active CEO card (the trio collapses).
- **Auto-clear is reason-true only** — `reconcileStaleParkCards` dismisses a park ONLY when its reason is genuinely gone (job left needs_attention / spec folded / Reva clean); a still-valid escalation is never silently dropped.
- **Execution path unchanged** — emit only surfaces the request; `POST /api/roadmap/approve` → `queued_resume` is untouched.

## Callers

- `scripts/builder-worker.ts` (poll loop) — runs `reconcileApprovalInbox(db)` ~every 20s.
- `src/app/api/developer/agents/inbox/route.ts` — consumes the `metadata.routed_to_function` / `approve_action_id` / `deep_link` the emitter stamps.

## CEO bounce-back affordance — `POST /api/developer/agents/inbox/bounce-back`

When a director escalates a sound diagnosis the CEO inbox can render only **Dismiss** for, a **Send back to {Director}** button re-queues the same escalation to the director with the richer [[../specs/director-judgment-lanes-fold-author-dismiss|judgment-lanes verdict surface]] — letting the director land an action this time without manual CEO work. Implemented by [[director-bounce-back]] + the inbox row's `ApprovalRow` component. The endpoint is owner-gated and depth-capped at one round-trip ([[../specs/bounce-escalation-back-to-director]]).

## Related

[[../specs/approval-routing-engine]] · [[approval-router]] · [[approvals-feed]] · [[director-bounce-back]] · [[../lifecycles/ada-slack-routed-approvals]] · [[../tables/function_autonomy]] · [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] · [[../tables/director_activity]] · [[../dashboard/agents]] · [[../dashboard/approvals]] · [[roadmap-actions]] · [[control-tower]] · [[../goals/devops-director]] · [[../operational-rules]]
