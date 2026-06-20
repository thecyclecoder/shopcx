# Journey delivery on portal tickets must post to the thread and email the customer ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `3bb28cfd-b86a-4099-a3c3-145b947e4f78`

launchJourneyForTicket() in src/lib/journey-delivery.ts has delivery branches only for email/help_center (line 193), chat (276), sms (288), meta_dm (298). getDeliveryChannel() (src/lib/delivery-channel.ts:19) passes 'portal' through unchanged, so portal-channel journeys match no branch: no CTA message is inserted, nothing is sent, yet the common post-delivery block (lines 308-338) still writes the 'delivered via portal' note, tags, journey_history, and returns true — a phantom success. Fix in three parts: (1) Add a 'portal' branch that inserts the lead-in + CTA button as a visibility:external outbound ticket_message (mirror the chat branch, lines 276-286) so the CTA appears in the portal conversation window. (2) Immediately after the insert, call sendPortalThreadEmail(admin, workspaceId, ticketId) from src/lib/portal/portal-thread-email.ts so the CTA is emailed to the customer exactly like every other portal reply (latest-on-top + history, Message-ID threaded back onto the ticket); the plain <a> button HTML renders correctly in that email. This matches how portal replies are delivered by deliver-pending-send.ts:343-352 and unified-ticket-handler.ts:72-79. (3) Make delivery fail loud: only write the 'delivered' note/tag/journey_history and return true when a branch actually emitted a message; if effectiveChannel matched no branch, write an internal error note ('Journey delivery FAILED: no delivery path for channel <x>') and return false, so dashboards never show a phantom send. Verify against ticket 3bb28cfd, whose only artifact was the internal note with no CTA bubble and no email.

## Problem (from ticket `3bb28cfd-b86a-4099-a3c3-145b947e4f78`)
A portal-channel ticket routed to the Cancel Subscription journey logged 'delivered via portal' and was tagged/closed, but no CTA was inserted in the thread and no email was sent — journey-delivery.ts has no portal branch, so portal journey launches silently no-op while reporting success. The customer (Krystin Newman) never received the journey by either channel.

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it would now be handled correctly.

> Authored by the box Improve agent from ticket `3bb28cfd-b86a-4099-a3c3-145b947e4f78`. Commission the build from the Roadmap board (owner = cs).
