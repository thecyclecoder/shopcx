# libraries/account-matching

Fuzzy name + address match heuristics for proposing account links.

**File:** `src/lib/account-matching.ts`

## File header

```
Account Matching — single source of truth for finding potential linked accounts.
Used by: unified ticket handler (detection), journey step builder (building steps),
and any future account linking logic.
```

## Exports

### `findUnlinkedMatches` — function

```ts
async function findUnlinkedMatches(workspaceId: string, customerId: string, adminClient?: Admin,) : Promise<PotentialMatch[]>
```

### `PotentialMatch` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
