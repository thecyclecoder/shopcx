# libraries/known-resellers

Reseller match logic: two-pass exact + Haiku fuzzy. See [[../lifecycles/fraud-detection]] § amazon_reseller.

**File:** `src/lib/known-resellers.ts`

## File header

```
Known-resellers discovery — scans Amazon SP-API for every seller
competing on our ASINs, scrapes their public storefront for the
registered business name + address, and upserts into the
known_resellers table.
Used by:
- one-shot CLI script (scripts/discover-resellers.ts)
- weekly cron (src/lib/inngest/reseller-discovery.ts)
Read-only on Amazon. Writes to: known_resellers, fraud_action_log.
```

## Exports

### `parseAddressLines` — function

```ts
function parseAddressLines(lines: string[]) : ParsedAddress
```

### `normalizeReseller` — function

```ts
function normalizeReseller(addr: { address1?: string | null; zip?: string | null }) : string
```

### `fetchSellerProfile` — function

```ts
async function fetchSellerProfile(amazonSellerId: string) : Promise<SellerProfile>
```

### `discoverResellers` — function

```ts
async function discoverResellers(workspaceId: string) : Promise<
```

### `ParsedAddress` — interface

## Callers

- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/add-to-resellers/route.ts`
- `src/lib/fraud-detector.ts`
- `src/lib/inngest/reseller-discovery.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
