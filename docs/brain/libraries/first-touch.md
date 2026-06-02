# libraries/first-touch

`markFirstTouch()` — applies `touched` + `ft:{source}` tag. Idempotent — only the first outbound touch matters.

**File:** `src/lib/first-touch.ts`

## Exports

### `markFirstTouch` — function

```ts
async function markFirstTouch(ticketId: string, source: "ai" | "workflow" | "journey" | "agent",) : Promise<void>
```

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`
- `src/lib/journey-delivery.ts`
- `src/lib/portal/handlers/cancel-journey.ts`

## Gotchas

- Idempotent — only the first outbound touch tags ft:*. Subsequent outbound doesn't replace it.

---

[[../README]] · [[../../CLAUDE]]
