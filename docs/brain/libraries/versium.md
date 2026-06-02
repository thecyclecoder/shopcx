# libraries/versium

Versium API client for demographics.

**File:** `src/lib/versium.ts`

## File header

```
Versium REACH API client — demographic append.
Enriches customer records with real demographic data (age, income, gender,
interests, household composition) instead of AI inference from names.
Docs: https://api-documentation.versium.com/reference/demographic-append-api
```

## Exports

### `fetchVersiumDemographics` — function

```ts
async function fetchVersiumDemographics(workspaceId: string, input: VersiumInput,) : Promise<VersiumDemographics | null>
```

### `VersiumDemographics` — interface

### `VersiumInput` — interface

## Callers

- `src/lib/inngest/customer-demographics.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
