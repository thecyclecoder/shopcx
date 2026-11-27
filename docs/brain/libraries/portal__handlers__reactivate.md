# libraries/portal/handlers/reactivate

Portal reactivate cancelled sub.

**File:** `src/lib/portal/handlers/reactivate.ts`

## Exports

### `reactivate` — const

```ts
const reactivate: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- The restart itself lives in [[subscription-reactivate]] `reactivateSubscription`, shared with the
  win-back journey's single-step route so both surfaces restart a subscription the same way
  (2026-11-21). This handler only resolves the sub, passes the customer's chosen date, maps
  `needs_payment_method` / `needs_address` to 409, and logs the portal event.
- **Restart-with-replacement (2026-11-27).** When the request body carries `replaceDiscontinued: true`,
  the handler resolves the offer BEFORE restarting (via [[reactivate-journey-builder]]
  `subDiscontinuedReplacement` on the resolved sub's items), passes `replaceDiscontinued` to
  `reactivateSubscription`, and returns the shared `replacementResultMessage` (`message`) + writes the
  shared `replacementTicketNote` — IDENTICAL to the win-back journey (CLAUDE.md: mini-site and live
  chat produce identical ticket messages). See [[../lifecycles/shopcx-subscriptions]] § Reactivation.

---

[[../README]] · [[../../CLAUDE]]
