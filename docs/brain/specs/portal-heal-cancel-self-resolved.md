# Portal healer: recognize self-resolved cancels and surface Appstle error bodies ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `28593e8a-c8b7-409c-825e-e61be1db6f29`

Ticket 28593e8a escalated a cancel that the customer had already completed. Appstle returned a transient 400 on the first confirm_cancel (a renewal had just billed), the portal made a portal-action-failed ticket, the customer retried and succeeded a minute later (portal.subscription.cancelled; sub now cancelled), but the healer escalated the stale ticket 15 min later. The healer has a self-resolution check for the changedate route but none for cancel, and the Appstle error body that would have classified the 400 as transient is discarded before the classifier sees it.

## Problem (from escalated ticket `28593e8a-c8b7-409c-825e-e61be1db6f29`)
Two concrete gaps. (1) src/lib/portal/remediation.ts has changedateSelfResolved() but no equivalent for the 'canceljourney'/'cancel' route, so a cancel the customer completed themselves still escalates to a human as 'Unrecognized portal error'. (2) src/lib/appstle.ts appstleSubscriptionAction (line 76-78) console.errors the Appstle response body but returns only `Appstle API error: ${res.status}`, so classifyPortalFailure cannot recognize transient 400s (e.g. Appstle 'billing operation is already in progress' right after a renewal bills) and routes them to a human instead of auto-retrying.

**Likely target:** `src/lib/portal/remediation.ts — add cancelSelfResolved(admin, workspaceId, ctx, ticket) mirroring changedateSelfResolved(): for routes 'canceljourney'/'cancel', before the disposition==='human' escalation, check whether the subscription row for ctx.payload.contractId is now status='cancelled' OR a portal.subscription.cancelled customer_event for that shopify_contract_id exists at/after ticket.created_at; if so, sysNote + 'auto-dismissed' tag + closeTicket instead of escalate. Also src/lib/appstle.ts appstleSubscriptionAction — return the response body text in the error field (e.g. `error: text || \`Appstle API error: ${res.status}\``, matching appstleSkipUpcomingOrder at line 371) so classifyPortalFailure's transient matcher ('operation is already in progress', etc.) can fire on 400s.`

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `28593e8a-c8b7-409c-825e-e61be1db6f29`. Commission the build from the Roadmap board (owner = cs).
