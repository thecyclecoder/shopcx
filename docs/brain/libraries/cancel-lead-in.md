# libraries/cancel-lead-in

Generates the lead-in message for cancel journey CTAs.

**File:** `src/lib/cancel-lead-in.ts`

## File header

```
Opus-generated lead-in for the cancel-flow remedies step.
Used by both:
- Journey mini-site: /api/journey/[token]/remedies
- Portal API handler: src/lib/portal/handlers/cancel-journey.ts
Three pillars: acknowledge, appreciate, save. Always pivots toward a
save-rebuttal that flips the customer's reason into a reason to stay.
Returns null on any failure — caller falls back to a generic line.
```

## Exports

### `generateCancelLeadIn` — function

```ts
async function generateCancelLeadIn(args: CancelLeadInArgs) : Promise<string | null>
```

### `CancelLeadInArgs` — interface

## Callers

- `src/app/api/journey/[token]/remedies/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
