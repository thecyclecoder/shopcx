# libraries/delivery-channel

Per-ticket-channel personality + delay config resolution.

**File:** `src/lib/delivery-channel.ts`

## File header

```
Determines the effective delivery channel for a ticket.
For chat tickets: if the customer has been idle for more than IDLE_THRESHOLD,
returns "email" so responses reach them via their inbox instead of a chat
window they've already left.
For all other channels, returns the ticket's original channel unchanged.
```

## Exports

### `getDeliveryChannel` — function

```ts
async function getDeliveryChannel(ticketId: string, ticketChannel: string,) : Promise<string>
```

## Callers

- `src/lib/journey-delivery.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
