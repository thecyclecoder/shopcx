# libraries/journey-delivery

Channel-aware journey delivery: email CTA, chat inline form, SMS / Meta DM URL. Honors `chat_idle` switch to email after 3 min.

**File:** `src/lib/journey-delivery.ts`

## File header

```
Generic journey delivery — routes to the correct delivery method per channel.
Email/Help Center → HTML CTA email with AI lead-in + button text
Chat → Embedded inline form (hides send input)
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

_None documented._

---

[[../README]] · [[../../CLAUDE]]
