# tickets-mutate

`src/lib/tickets-mutate.ts` — the typed WRITE surface for a support ticket. Two clearly-separated layers.

## (A) Ticket-row state — deterministic, no model, no customer message

Mutate the `tickets` row itself. Used by deterministic flows (outreach auto-close, sol-closes-on-resolving-reply) and hand-fixes.

`closeTicket` · `reopenTicket` · `setTicketStatus` · `escalateTicket` · `assignTicket` · `addTag` / `removeTag` · `armPlaybook` / `advancePlaybookStep` / `clearPlaybook` · `setDoNotReply`. `TicketStatus = 'open'|'pending'|'closed'|'archived'`.

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
