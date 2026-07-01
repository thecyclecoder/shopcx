# classifyPortalFailure — recognize Braintree processor rejections as customer-input errors

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `f5c87895-30fd-4509-a6e2-f989fc2987e1`

Robin Burroughs' ticket f5c87895 escalated because classifyPortalFailure() had no branch for the string 'vault_failed — Expired Card' returned by Braintree's $0-auth verifyCard step. The portal UI already showed her the failure inline at the moment of submit; the resulting portal-action-failed ticket then escalated to the AI Routine even though there is nothing a human can do about her card being past its expiration date. Teach the classifier that processor rejections are customer-input errors (analogous to insufficient_points) so these tickets auto-dismiss instead of piling into the escalation queue.

## Problem (from escalated ticket `f5c87895-30fd-4509-a6e2-f989fc2987e1`)
src/lib/portal/remediation.ts:123-178 classifies user/UI validation errors as 'dismiss', Appstle/gateway transients as 'retry', and everything else as 'human'. Braintree processor responses ('Expired Card', 'Do Not Honor', 'Declined', 'Insufficient Funds', 'Invalid CVV', 'Invalid ZIP', 'Invalid Credit Card Number', 'Fraud', 'Lost/Stolen Card', 'Gateway Rejected') fall through to the catch-all human branch on line 177 with 'Unrecognized portal error — needs a human to review.' — but every one of these is the customer's card being rejected by the issuer at $0-auth. src/lib/portal/handlers/payment-method-update.ts:71 already rethrows the message verbatim, so the raw processor text reaches the classifier. Every card decline through the portal today generates an unnecessary escalation.

**Likely target:** `src/lib/portal/remediation.ts (add a new 'processor rejection' branch to classifyPortalFailure with a dismiss disposition and a customer-facing reason string that names the specific decline; the portal-action-healer should tag the auto-dismissed ticket 'card-declined' so we can measure how often this fires) + src/lib/portal/remediation.test.ts (unit tests for each processor-rejection string, mirroring the would_remove_last_item pattern). Follow-up: consider a lightweight ticket-note/email nudge to the customer when we dismiss a card-declined ticket, since the sub may lapse if they don't retry.`

## Phases
- **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `f5c87895-30fd-4509-a6e2-f989fc2987e1`. Commission the build from the Roadmap board (owner = cs).
