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

- **Per-branch indexed queries, not one mixed `.or()`.** `findUnlinkedMatches` matches on three
  branches — `and(first_name, last_name)`, `phone`, and `email ilike local@%`. These run as
  **separate** queries (`Promise.all`) merged + deduped by id in memory, *not* a single
  `.or(...)`. A combined OR forced a Seq Scan of the 620k-row customers table (the
  case-insensitive email ILIKE branch is non-indexable on a plain btree, and the OR defeats the
  `workspace_id` index); concurrent portal-bootstrap / sonnet / journey-builder calls saturated
  the pool → PostgREST 500 (Control Tower signature `supabase-logs:b5db594131381078`). Each
  branch now rides its own index:
  - name → `idx_customers_name_match (workspace_id, first_name, last_name)`
  - phone → `idx_customers_phone (workspace_id, phone)` partial
  - email → `idx_customers_email_trgm` gin trgm (added 2026-06-14)
  Added in `supabase/migrations/20260706130000_account_matching_indexes.sql`. **If you add a new
  match branch, add a matching index and keep it a separate query** — never fold it back into one
  `.or()`.

---

[[../README]] · [[../../CLAUDE]]
