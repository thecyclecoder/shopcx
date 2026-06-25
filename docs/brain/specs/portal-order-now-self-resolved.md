# Portal ordernow — auto-dismiss when the order has already landed

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `a21341d0-f3e5-469a-9fff-ee3b0c0fc5d6`

Prevent portal Order-Now double-clicks (and any other case where Appstle 400s the second billing attempt while the first is in flight) from spawning escalated tickets like Renee Fragoulias's a21341d0 when the customer's order has actually landed. The existing collision short-circuit in src/lib/portal/handlers/order-now.ts only catches the case where Appstle returns the exact text 'billing operation is already in progress'; Appstle also returns a generic 400 with an empty body, which falls through and escalates. Add a state-based self-resolution check to the healer (it works regardless of Appstle's body) so these auto-close instead of escalating.

## Problem (from escalated ticket `a21341d0-f3e5-469a-9fff-ee3b0c0fc5d6`)
Ticket a21341d0 (Renee Fragoulias, fragouliasfam@aol.com, contract 27901788333). Customer clicked Order Now twice at 18:46:02 and 18:46:36 UTC on 2026-06-25. The first click's appstleAttemptBilling was still running when the second click fired, so Appstle returned HTTP 400 with empty body. order-now.ts:60 only short-circuits on `/billing operation is already in progress/i`, which the empty body doesn't match, so handleAppstleError wrapped it as `appstle_error` and the portal route created a portal-action-failed ticket. classifyPortalFailure in src/lib/portal/remediation.ts fell to `human` because the error text didn't match any transient pattern, and escalate() set escalated_at — despite order #SC133466 ($117.15) landing on this subscription 60 seconds after the failure (order.created event 18:47:39). The healer already has `cancelSelfResolved` (lines 292–332) and `changedateSelfResolved` (lines 225–275) doing exactly this kind of state check; the ordernow route is the missing branch.

**Likely target:** `src/lib/portal/remediation.ts — add `orderNowSelfResolved(admin, workspaceId, ctx, ticket)` that returns resolved=true when EITHER (a) a `portal.order_now` customer_event with `properties.shopify_contract_id === ctx.payload.contractId` and `properties.collision !== true` exists between `ticket.created_at - 5min` and now (the customer's prior successful click), OR (b) an `orders` row exists for the matching subscription with `created_at` between `ticket.created_at - 2min` and `ticket.created_at + 5min`. Wire it into `remediatePortalTicket` next to the existing CANCEL_ROUTES / changedate branches so an ordernow failure short-circuits BEFORE classifyPortalFailure runs. Also extend the brain doc at docs/brain/archive.d/portal-order-now-billing-collision-noise.md (or its current lifecycle home) noting that the body-text short-circuit handles the explicit Appstle phrase while the new self-resolved check handles empty-body 400s.`

## Phases
- **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `a21341d0-f3e5-469a-9fff-ee3b0c0fc5d6`. Commission the build from the Roadmap board (owner = cs).
