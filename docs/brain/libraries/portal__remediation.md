# libraries/portal/remediation

Triage + auto-resolution for **"Portal action needs help"** tickets — the ones created when a customer hits an error doing a self-serve portal action (see [[portal__route]] / `app/api/portal/route.ts`, which tags them `portal-action-failed`). Those tickets carry no customer message, so the AI pipeline never runs on them; without this they just pile up open forever.

**File:** `src/lib/portal/remediation.ts`

## What it does

Each ticket is classified into one of three dispositions and acted on:

| Disposition | Trigger | Action |
|---|---|---|
| **retry** | Transient Appstle/infra error — *"Another billing operation is already in progress"*, timeouts, 429/503/504 | Re-run the original action via `healPortalAction`; close on success |
| **dismiss** | User/UI validation error that can't be completed — *"Insufficient points"*, `would_remove_last_item` / `would_remove_all_regular_products` (and the raw *"at least one subscription product must be present"* Appstle text) | Close + tag `auto-dismissed` |
| **human** | Anything unrecognized, no failure context, retries exhausted (3), no replay for the route, or a non-transient error surfaced on retry | **Escalate to the AI Routine** (sets `escalated_at` + `escalation_reason`, `escalated_to = null`); leave open |

The same entry point (`remediatePortalTicket`) is used by the manual one-off pass and the [[../inngest/portal-action-healer]] cron, so behaviour is identical.

## Key design decisions

- **Classify on the error *message*, not the HTTP status.** The portal route wraps **every** Appstle error as HTTP 502 (`handleAppstleError`), so the status is useless for transient detection. A genuine hard error (e.g. *"Next billing date is invalid"*) would retry forever if we trusted 502. We key off the message text.
- **Match the normalized *code*, not just raw Appstle text.** [[portal__route]] records `body.error` (the stable code, e.g. `would_remove_last_item`) into the `portal.error` event — the raw Appstle strings the dismiss branch historically matched (*"at least one subscription product"*) never reach a portal-created ticket, so a benign last-item removal escalated to a human. The dismiss branch now matches `would_remove_last_item` **and** its replace-variants sibling `would_remove_all_regular_products` by code. Belt-and-suspenders with the PRIMARY suppression in [[portal__route]]'s `VALIDATION_ERRORS` (which stops the ticket spawning at all) — this BACKSTOP cleans up any already-created ones.
- **`detail` is folded into the failure context.** Portal handlers carry their friendly text in `body.detail`, not `body.message` (which is often null), so `getFailureContext` joins `[error, message, detail]` — and [[portal__route]] now persists `detail` on the `portal.error` event + the ticket note. Without this the text-matching dismiss branches were silently unmatchable for any handler that used `detail`.
- **Failure context comes from the `portal.error` customer_event, latest-wins.** A customer who retried a date change three times wants the date from their **last** attempt, not the stale value baked into the ticket note. `getFailureContext` pulls the most recent `portal.error` event for that customer+route at/after ticket creation; falls back to parsing the creation note for older tickets.
- **A human disposition *escalates*, it does not just tag.** Each human branch — unrecognized error, no failure context, auto-heal exhausted, no replay for the route, non-transient error on retry — calls `escalate()`, which sets `escalated_at` + `escalation_reason` on the ticket with **`escalated_to = null`** — the [[../inngest/triage-escalations]] idle-triage cron's "routine-owned" signal. This is what puts it in the escalation queue that `/api/escalated` (`src/app/api/escalated/route.ts`) and the `escalated=true` filter on `/api/tickets` surface; the AI Routine then triages it (solver→skeptic→quorum) and its no-quorum path hands up to a real human. The old behaviour only added a `needs-human` tag, which **no human-facing queue shows** — so triaged tickets silently piled up unseen (the founder's complaint, ticket `11746b62`). *(Originally escalated to the workspace `role='owner'` member; [[../inngest/triage-escalations]]'s "escalate to the AI Routine by default" change later dropped the owner lookup so portal escalations land in the routine like every other system escalation — the `workspaceOwner` helper was removed.)*
- **Escalation is also the idempotency guard.** `remediatePortalTicket` short-circuits at the top when `assigned_to`, `escalated_to`, **or `escalated_at`** is set, so an already-escalated ticket is never re-run — no need to re-tag or re-hammer Appstle. (The guard keys on **`escalated_at`** now that routine escalations leave `escalated_to` null.) The `needs-human` tag is **retired** as the routing/idempotency mechanism; a pre-existing `needs-human` ticket (no `escalated_at`) is escalated on its next pass (backlog migration) rather than skipped forever.
- **Attempt count is derived from the ticket's own `[Auto-heal attempt N]` notes** — no extra column. After `MAX_HEAL_ATTEMPTS` (3) transient failures the ticket hits the human disposition → `escalate()` (to the AI Routine).
- **Self-resolution guard before a `changedate` replay.** Before re-applying a date change, `changedateSelfResolved` checks whether the customer already got what they wanted — (a) they re-did the date change themselves (`portal.date.changed` event for the same contract after the failure), or (b) they wanted the order *sooner* (requested date earlier than the current scheduled date) and an order has since landed on that exact subscription (`orders.subscription_id`), e.g. they hit "Order now". Either way → auto-dismiss instead of mutating a stale date. The "sooner" direction is required for (b) so a *delay* request is never auto-dismissed just because the cycle billed anyway. (Real case: SC132357 placed ~40s after the date error.)
- **Self-resolution guard for `cancel`.** A cancel that the customer completed themselves shouldn't escalate (or retry). For the cancel routes (`cancel` / `canceljourney` / `cancelJourney` / `cancel_journey`), `cancelSelfResolved` runs **right after classification — for any disposition** — and auto-dismisses when (a) a `portal.subscription.cancelled` customer_event exists for that `shopify_contract_id` at/after the ticket's `created_at` (the customer's successful retry), or (b) the `subscriptions` row for that contract is now `status='cancelled'` (the cancel landed by any path). This covers two failure modes seen in ticket `28593e8a`: a transient 400 that **now classifies as `retry`** (cancel has no `healPortalAction` replay, so it would otherwise escalate as "no replay for route") *and* an unrecognized 400 that classifies as `human`. Root cause was a transient Appstle 400 ("billing operation is already in progress") right after a renewal billed; the customer retried a minute later and succeeded, but the healer escalated the stale ticket 15 min later. Paired with the [[appstle]] fix below.
- **Transient-cancel detection depends on the Appstle error body.** [[appstle]] `appstleSubscriptionAction` now returns the Appstle response body in `error` (was a bare `Appstle API error: <status>`), so `classifyPortalFailure`'s transient matcher (`"billing operation is already in progress"`, …) can fire on cancel 400s — without it the cancel never even reaches the `retry` path.
- **Only idempotent routes have a replay.** `healPortalAction` currently implements `changedate` → `appstleUpdateNextBillingDate` (the one real healable case seen in production). Unknown routes return `unsupported` → routed to a human, never guessed. Add routes to the `switch` as needed; never add a non-idempotent one (e.g. `order-now` would double-charge).

## Exports

- `remediatePortalTicket(admin, ticket)` → `RemediationOutcome` — triage + act on one ticket. Idempotent.
- `fetchOpenPortalFailures(admin, workspaceId, windowDays=14)` → `TicketRow[]` — open `portal-action-failed` tickets in the recent window.
- `classifyPortalFailure(ctx)` → `{ disposition, reason }`
- `healPortalAction(admin, workspaceId, ctx)` → `{ success, detail?, error?, unsupported? }`
- `getFailureContext(admin, ticket)` → `FailureContext | null`
- `routeFromSubject(subject)` → route slug

(Internal: `escalate(admin, ticket, reason)` sets `escalated_at` + `escalation_reason` with `escalated_to = null` → routes the ticket to the AI Routine.)

## Callers

- [[../inngest/portal-action-healer]] — the 15-min cron
- `scripts/_portal-remediate.ts` — manual one-off pass (used to clear the first batch, 2026-06-11)

## Source prevention

`app/api/portal/route.ts` now skips ticket creation for validation errors that should never have been offered — `insufficient_points` (and any `error` matching `/^insufficient points/i`), plus the empties-a-subscription guardrails `would_remove_last_item` (remove-line-item) and `would_remove_all_regular_products` (replace-variants). The loyalty redeem UI already disables unaffordable tiers (`affordable` flag from `loyaltyBalance`, same `member.points_balance` source as the server-side `validateRedemption`), and the remove/replace flows should route the customer to cancel rather than offer a last-item removal — so a real ticket here means a stale/old client. The route guard stops it spawning a ticket regardless; the dismiss branch above is the backstop for any that predate the guard.

---

[[../README]] · [[../../CLAUDE]] · [[../inngest/portal-action-healer]] · [[../inngest/triage-escalations]] · [[../libraries/ticket-analyzer]] · [[../dashboard/tickets__escalated]]
