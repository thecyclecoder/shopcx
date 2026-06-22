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

## Control Tower coverage (`ai:journey-delivery`)

`launchJourneyForTicket` is an **inline AI agent** in the [[control-tower]] (`ai:journey-delivery`). It delegates to `launchJourneyForTicketImpl` inside a try/finally and emits one [[../tables/loop_heartbeats]] beat per run via `emitInlineAgentHeartbeat("journey-delivery", …)`: **ok:true** when delivered (`produced = { ticket_id, journey_id, journey, channel }`) or the one by-design non-delivery (`social_comments`, which has no journeys); **ok:false** on a fail-loud non-delivery (no channel path / missing email/config) or a throw. The monitor's silent-while-work-exists check pairs this with `journey_sessions` created in the window (a session is inserted *before* the channel send — i.e. "queued but not delivered" = sessions exist but 0 successful beats). See [[control-tower]] · [[../specs/control-tower-agent-coverage]].

---

[[../README]] · [[../../CLAUDE]]
