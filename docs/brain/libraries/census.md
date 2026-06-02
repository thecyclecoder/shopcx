# libraries/census

US Census API client for demographics.

**File:** `src/lib/census.ts`

## File header

```
US Census Bureau API client.
Pulls zip-code-level demographics from the ACS 5-year estimates, caches
results in public.zip_code_demographics (40K US zips max — tiny table),
and refreshes annually. Works without an API key but is rate-limited;
pass a key (from workspaces.census_api_key_encrypted, decrypted) for
higher limits.
```

## Exports

### `incomeToBracket` — function

```ts
function incomeToBracket(income: number | null) : IncomeBracket | null
```

### `classifyUrban` — function

```ts
function classifyUrban(population: number | null) : UrbanClassification | null
```

### `timezoneFromState` — function

```ts
function timezoneFromState(stateCode: string | null | undefined) : string | null
```

### `fetchZipDemographics` — function

```ts
async function fetchZipDemographics(zip: string, apiKey?: string,) : Promise<ZipDemographics | null>
```

### `ZipDemographics` — interface

### `IncomeBracket` — type

### `UrbanClassification` — type

## Callers

- `src/lib/inngest/customer-demographics.ts`
- `src/lib/marketing-text-timezone.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
