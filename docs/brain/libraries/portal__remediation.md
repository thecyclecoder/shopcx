# libraries/portal/remediation

Triage + auto-resolution for **"Portal action needs help"** tickets — the ones created when a customer hits an error doing a self-serve portal action (see [[portal__route]] / `app/api/portal/route.ts`, which tags them `portal-action-failed`). Those tickets carry no customer message, so the AI pipeline never runs on them; without this they just pile up open forever.

**File:** `src/lib/portal/remediation.ts`

## What it does

Each ticket is classified into one of three dispositions and acted on:

| Disposition | Trigger | Action |
|---|---|---|
| **retry** | Transient Appstle/infra error — *"Another billing operation is already in progress"*, timeouts, 429/503/504 | Re-run the original action via `healPortalAction`; close on success |
| **dismiss** | User/UI validation error that can't be completed — *"Insufficient points"*, *"at least one subscription product must be present"* | Close + tag `auto-dismissed` |
| **human** | Anything unrecognized, no failure context, retries exhausted (3), no replay for the route, or a non-transient error surfaced on retry | **Escalate to the workspace owner** (sets `escalated_to`/`escalated_at`/`escalation_reason`); leave open |

The same entry point (`remediatePortalTicket`) is used by the manual one-off pass and the [[../inngest/portal-action-healer]] cron, so behaviour is identical.

## Key design decisions

- **Classify on the error *message*, not the HTTP status.** The portal route wraps **every** Appstle error as HTTP 502 (`handleAppstleError`), so the status is useless for transient detection. A genuine hard error (e.g. *"Next billing date is invalid"*) would retry forever if we trusted 502. We key off the message text.
- **Failure context comes from the `portal.error` customer_event, latest-wins.** A customer who retried a date change three times wants the date from their **last** attempt, not the stale value baked into the ticket note. `getFailureContext` pulls the most recent `portal.error` event for that customer+route at/after ticket creation; falls back to parsing the creation note for older tickets.
- **A human disposition *escalates*, it does not just tag.** Each human branch — unrecognized error, no failure context, auto-heal exhausted, no replay for the route, non-transient error on retry — calls `escalate()`, which resolves the workspace owner (`workspace_members` where `role='owner'`, mirroring `app/api/todos/[id]/reject/route.ts`) and sets `escalated_to` + `escalated_at` + `escalation_reason` on the ticket. This is what puts it in the escalation queue that `/api/escalated` (`src/app/api/escalated/route.ts`) and the `escalated=true` filter on `/api/tickets` surface. The old behaviour only added a `needs-human` tag, which **no human-facing queue shows** — so triaged tickets silently piled up unseen (the founder's complaint, ticket `11746b62`).
- **Escalation is also the idempotency guard.** `remediatePortalTicket` short-circuits at the top when `assigned_to` **or** `escalated_to` is set, so an already-escalated ticket is never re-run — no need to re-tag or re-hammer Appstle. The `needs-human` tag is **retired** as the routing/idempotency mechanism; a pre-existing `needs-human` ticket (no `escalated_to`) is escalated on its next pass (backlog migration) rather than skipped forever.
- **Attempt count is derived from the ticket's own `[Auto-heal attempt N]` notes** — no extra column. After `MAX_HEAL_ATTEMPTS` (3) transient failures the ticket goes `needs-human`.
- **Self-resolution guard before a `changedate` replay.** Before re-applying a date change, `changedateSelfResolved` checks whether the customer already got what they wanted — (a) they re-did the date change themselves (`portal.date.changed` event for the same contract after the failure), or (b) they wanted the order *sooner* (requested date earlier than the current scheduled date) and an order has since landed on that exact subscription (`orders.subscription_id`), e.g. they hit "Order now". Either way → auto-dismiss instead of mutating a stale date. The "sooner" direction is required for (b) so a *delay* request is never auto-dismissed just because the cycle billed anyway. (Real case: SC132357 placed ~40s after the date error.)
- **Only idempotent routes have a replay.** `healPortalAction` currently implements `changedate` → `appstleUpdateNextBillingDate` (the one real healable case seen in production). Unknown routes return `unsupported` → routed to a human, never guessed. Add routes to the `switch` as needed; never add a non-idempotent one (e.g. `order-now` would double-charge).

## Exports

- `remediatePortalTicket(admin, ticket)` → `RemediationOutcome` — triage + act on one ticket. Idempotent.
- `fetchOpenPortalFailures(admin, workspaceId, windowDays=14)` → `TicketRow[]` — open `portal-action-failed` tickets in the recent window.
- `classifyPortalFailure(ctx)` → `{ disposition, reason }`
- `healPortalAction(admin, workspaceId, ctx)` → `{ success, detail?, error?, unsupported? }`
- `getFailureContext(admin, ticket)` → `FailureContext | null`
- `routeFromSubject(subject)` → route slug

(Internal: `escalate(admin, ticket, reason)` sets the escalation columns + routes to the workspace owner; `workspaceOwner(admin, workspaceId)` resolves the `role='owner'` member.)

## Callers

- [[../inngest/portal-action-healer]] — the 15-min cron
- `scripts/_portal-remediate.ts` — manual one-off pass (used to clear the first batch, 2026-06-11)

## Source prevention

`app/api/portal/route.ts` now skips ticket creation for validation errors that should never have been offered — including `insufficient_points` and any `error` matching `/^insufficient points/i`. The loyalty redeem UI already disables unaffordable tiers (`affordable` flag from `loyaltyBalance`, same `member.points_balance` source as the server-side `validateRedemption`), so a real ticket here means a stale/old client — the route guard stops it spawning a ticket regardless.

---

[[../README]] · [[../../CLAUDE]]
