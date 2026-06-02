# libraries/ticket-tags

`addTicketTag()` — idempotent tag set. Used everywhere downstream effects need to be tagged.

**File:** `src/lib/ticket-tags.ts`

## Exports

### `addTicketTag` — function

```ts
async function addTicketTag(ticketId: string, tag: string) : Promise<void>
```

## Callers

- `src/lib/inngest/dunning.ts`
- `src/lib/inngest/unified-ticket-handler.ts`
- `src/lib/journey-delivery.ts`
- `src/lib/portal/handlers/cancel-journey.ts`

## Gotchas

- Idempotent set. Calling `addTicketTag()` with an already-applied tag is a no-op.

---

[[../README]] · [[../../CLAUDE]]
