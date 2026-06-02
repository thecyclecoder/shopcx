# libraries/social-comment-customer-match

Match comment author / DM sender → internal customer. Looks up [[../tables/meta_sender_customer_links]] first; falls back to email match.

**File:** `src/lib/social-comment-customer-match.ts`

## File header

```
Match a Meta social-comment sender (display name from FB/IG) to one
or more `customers` rows. Common case: "Suzy Doucet" on FB →
"Suzanne Doucet" in our DB.
Strategy:
1. Last name exact match (case-insensitive) — anchors the match.
2. Among those, score first-name similarity:
a. exact match               → score 100
b. one is a prefix of other  → 90
c. nickname dictionary hit   → 85
d. shared 3+ char prefix     → 70
else excluded
3. Roll up to linked-account groups so duplicate profiles for the
same person show as one candidate (we surface the canonical
customer — the one with the most activity).
4. Enrich with ticket count + LTV + last-order date + active-sub
flag so the UI can render rich cards.
Cheap: 2-3 DB queries, no AI. Returns up to 5 candidates ranked by
(name score) then (active sub) then (LTV).
```

## Exports

### `findCustomerCandidatesByMetaName` — function

```ts
async function findCustomerCandidatesByMetaName(admin: Admin, workspaceId: string, metaSenderName: string | null, metaSenderId?: string | null,) : Promise<CustomerCandidate[]>
```

### `CustomerCandidate` — interface

## Callers

- `src/app/api/workspaces/[id]/social-comments/[commentId]/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
