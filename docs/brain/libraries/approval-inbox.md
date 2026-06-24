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

## Exports

- **`reconcileApprovalInbox(admin)`** → `Promise<{ created, dismissed }>` — the sweep (above).
- **`ownerFunctionForKind(kind)`** → `string | null` — kind → owning function (null ⇒ unknown ⇒ CEO).
- **`buildApprovalContent(job)`** → `{ title, body }` — the inline title + investigation body.
- **`inlineApproveActionId(job)`** → `string | null` — the single plain approve/decline action, else null (back-compat).
- **`inlineApproveActions(job)`** → `InboxApprovalAction[] | null` (Phase 4) — every still-pending plain action for inline multi-action/multi-branch decisioning; `null` when any action is multi-choice.
- **`approvalDeepLink(kind, specSlug, specMissing?)`** → `string` — the canonical decide-surface fallback (multi-choice).
- **`routedInboxHref(role?)`** (in `inbox.ts`) → `string` — the `/dashboard/agents?view=inbox&role=…` deep-link every migrated surface points at (Phase 4).
- **`buildApprovalNotification(job, chart, autonomy)`** → the resolved notification row (pure given the snapshot).
- Type **`ApprovalJobRow`** — the `agent_jobs` columns the emitter reads.

## Safety invariants

- **Route up, never sideways/down** + **default to CEO** — inherited from [[approval-router]] `resolveApprover` (unchanged here).
- **No orphans** — the reconciler is exhaustive over `needs_approval`; a request with no resolvable approver routes to the CEO, never dropped.
- **Idempotent** — keyed on `metadata.agent_job_id`; re-parks don't duplicate.
- **Execution path unchanged** — emit only surfaces the request; `POST /api/roadmap/approve` → `queued_resume` is untouched.

## Callers

- `scripts/builder-worker.ts` (poll loop) — runs `reconcileApprovalInbox(db)` ~every 20s.
- `src/app/api/developer/agents/inbox/route.ts` — consumes the `metadata.routed_to_function` / `approve_action_id` / `deep_link` the emitter stamps.

## Related

[[../specs/approval-routing-engine]] · [[approval-router]] · [[../tables/function_autonomy]] · [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] · [[../dashboard/agents]] · [[roadmap-actions]] · [[control-tower]] · [[../goals/devops-director]] · [[../operational-rules]]
