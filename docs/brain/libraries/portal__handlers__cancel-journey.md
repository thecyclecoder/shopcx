# libraries/portal/handlers/cancel-journey

Portal-side cancel journey step handler.

**File:** `src/lib/portal/handlers/cancel-journey.ts`

## File header

```
Cancel journey endpoints for portal — returns journey steps and processes responses
```

## Exports

### `cancelJourney` — const

```ts
const cancelJourney: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- Save offers (`remedy` step) and item edits (`line_item_action` step) are applied by [[remedy-actions]], shared with the journey / mini-site cancel flow. Don't re-inline remedy logic here (2026-11-16).

_None documented._

---

[[../README]] · [[../../CLAUDE]]
