# tickets-mutate

`src/lib/tickets-mutate.ts` — the typed WRITE surface for a support ticket. Two clearly-separated layers.

## (A) Ticket-row state — deterministic, no model, no customer message

Mutate the `tickets` row itself. Used by deterministic flows (outreach auto-close, sol-closes-on-resolving-reply) and hand-fixes.

`closeTicket` · `reopenTicket` · `setTicketStatus` · `escalateTicket` · `assignTicket` · `addTag` / `removeTag` · `armPlaybook` / `advancePlaybookStep` / `clearPlaybook` · `setDoNotReply`. `TicketStatus = 'open'|'pending'|'closed'|'archived'`.

### `closeTicket` — preserves the escalation triple by default

Sets `status='closed'` + `closed_at` + `updated_at`. The escalation columns (`escalated_to`, `escalated_at`, `escalation_reason`) are PRESERVED — a closed ticket that was escalated stays visibly closed-over-an-active-escalation instead of looking identical to a ticket that was never escalated.

Opt-ins:
- `{ clearEscalation: true }` — deliberate founder close (the escalation was ruled on). Clears `escalated_to` + `escalated_at`; `escalation_reason` survives as the audit of WHY it was escalated.
- `{ reason }` — explicitly overwrites `escalation_reason` (rare — only when the close records a different resolution summary than the original).

**Why (Denise Richling, ticket 6b0cd91c, 2026-08-28):** the old `closeTicket` blanket-nulled the triple, so a founder escalation that got auto-closed on a positive customer reply became indistinguishable from a never-escalated ticket. Nine such cases accumulated silently in 21 days; hers had a confirmed system-side $102.33 duplicate charge unrefunded. See [[../specs/closing-a-ticket-must-not-destroy-an-active-escalation]] Phase 1. The paired guard sits at [[../inngest/unified-ticket-handler]] `setStatus` — a compare-and-set `.is("escalated_to", null)` on the auto-close write, so a positive-reply auto-close cannot fire on an actively-escalated ticket.

## (B) Commerce / journeys / workflows — the ONE executor front door

NOT re-implemented here. Every subscription/order/loyalty/crisis/customer mutation + journeys/playbooks/workflows/macros/escalate lives behind `executeSonnetDecision` ([[action-executor]], 39 `directActionHandlers` + 8 `action_type`s). These thin wrappers are the single front door onto it — the SAME path the Improve tab uses — so a hand-fix or Sol's cheap-execution reaches all of it with zero drift + the selective-clarify gate + resolution-events ledger.

| Symbol | Purpose |
|---|---|
| `RunTicketDecisionResult` | `{messageSent, escalated, closed, statusManaged}` |
| `runTicketDecision(admin, {workspaceId, ticketId, decision, sandbox?, auditPrefix?})` | execute a full `SonnetDecision`. Resolves customer + channel, wires the portal-aware delivery sink, logs an audit note. `sandbox` defaults to the workspace's `sandbox_mode`. |
| `launchJourney(admin, {workspaceId, ticketId, journey, leadIn, ctaText?, subscriptionId?, orderId?, …})` | build a `journey` decision + delegate. REQUIRES `leadIn` (throws on empty — a journey never ships a bare button). ALWAYS delivered as a clickable CTA. `subscriptionId`/`orderId` are optional hints; NEVER pass `subscriptionId` for cancel. |
| `runWorkflow(admin, {workspaceId, ticketId, workflow, …})` | build a `workflow` decision + delegate; the workflow manages final status itself. |

## Callers

[[agent-action-queue]] `executeActionRequest` (Sol's enqueue-poll execution) · hand-fixes · [[improve-plan-executor]].

Read side: [[tickets-read]]. Threaded replies: [[tickets-reply]]. Catalog of everything reachable: [[../orchestrator-tools]].
