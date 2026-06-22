# libraries/journey-delivery

Channel-aware journey delivery: email CTA, chat CTA bubble, portal CTA bubble + email, SMS / Meta DM URL. Honors `chat_idle` switch to email after 3 min.

**File:** `src/lib/journey-delivery.ts`

## File header

```
Generic journey delivery — routes to the correct delivery method per channel.
Email/Help Center → HTML CTA email with AI lead-in + button text
Chat → CTA link bubble in the chat window
Portal → CTA bubble in the portal thread + emailed to the customer
SMS/Meta DM → Plain text message with URL link
Social Comments → N/A (no journeys)
```

## Exports

### `launchJourneyForTicket` — function

```ts
async function launchJourneyForTicket(params: LaunchParams) : Promise<boolean>
```

### `nudgeJourney` — function

```ts
async function nudgeJourney(workspaceId: string, ticketId: string, journeyEntry: { journey_id: string; journey_name: string }, channel: string, customerMessage: string, personality: { name?: string; tone?: string } | null,) : Promise<boolean>
```

## Callers

- `src/app/api/tickets/[id]/send-crisis-journey/route.ts`
- `src/app/api/tickets/[id]/send-journey/route.ts`
- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

- **Portal branch is mandatory + fail-loud.** `getDeliveryChannel()` passes `portal` through unchanged, so a portal-channel journey must hit the dedicated `portal` branch: it inserts the lead-in + CTA as a `visibility:external` outbound `ticket_message` (so the CTA shows in the portal conversation window) and then calls `sendPortalThreadEmail(admin, workspaceId, ticketId)` ([[portal__thread-email]]) so the customer is emailed exactly like every other portal reply (latest-on-top + history, Message-ID threaded back onto the ticket). Mirrors `deliver-pending-send.ts` / `unified-ticket-handler.ts`.
- **No phantom sends.** Each channel branch sets a local `delivered` flag. If no branch matched the effective channel, `launchJourneyForTicket` writes an internal `[System] Journey delivery FAILED: no delivery path for channel <x>` note and returns `false` — it does NOT write the `delivered` note/tag/`journey_history`. Previously a portal journey fell through every branch yet still logged success (ticket `3bb28cfd`: internal "delivered via portal" note, no CTA bubble, no email).
- **Control Tower coverage (`ai:journey-delivery`).** `launchJourneyForTicket` is a public wrapper around `launchJourneyForTicketInner` that emits ONE [[../tables/loop_heartbeats]] beat in a try/finally at the end of every run ([[../specs/control-tower-agent-coverage]] · [[control-tower]]). `ok:false` on a thrown run OR a non-delivery (`return false`), except a `social_comments` channel where journeys are N/A by design (intentional skip ⇒ `ok:true`); `produced` carries `{delivered, journey, ticket, channel}`. The monitor's liveness-when-work-exists alert fires when [[../tables/journey_sessions]] were created in the window but 0 successful delivery beats landed.

---

[[../README]] · [[../../CLAUDE]]
