# libraries/replacement-stall

Detect + reconcile stalled replacements; flip a stalled row from `address_confirmed` to `superseded` when a later replacement for the same original order fulfills the items.

**File:** `src/lib/replacement-stall.ts`

## File header

```
Stall detection + `superseded`-status reconciliation for the `public.replacements` table.

The SC132221 rot pattern: Evan H.'s Jun-23 replacement sat at `status='address_confirmed'` 
with `replacement_order_id = null` for 17 days because the Shopify draft-order call silently 
failed (the "UN" countryCode bug — [[replacement-order#countryCode normalization]]). The row 
surfaced nowhere; Sol only discovered it on 2026-07-10 while investigating the customer's 
other ticket.

Two problems solved:
  1. A stalled row must SURFACE (Improve/alert) past a threshold — not silently rot at 
     address_confirmed forever.
  2. When a LATER replacement for the same original_order fulfills the items 
     (SC134462 + SC134463 shipped the two owed tabs), the stale record needs a first-class 
     terminal status (`superseded`) — not a red `failed` (the customer outcome was correct) 
     and not a lingering `address_confirmed`.

This library is the pure + read-only + narrow-write surface for both. Callers (a cron, an 
ops script, or CS on the fly) use it. All mutations are compare-and-set-guarded — a supersede 
write can only fire when the row is still `address_confirmed` in the same workspace, so a 
raced or already-terminal row can't be overwritten.
```

## Exports

### `DEFAULT_STALL_THRESHOLD_DAYS` — constant

```ts
export const DEFAULT_STALL_THRESHOLD_DAYS = 7
```

Default: a replacement stuck at address_confirmed for 7+ days is stalled. Evan's SC132221 record sat 17. 7 days is well past any normal retry window (address confirm → Shopify draft usually completes in seconds — hours at the extreme when a customer takes time to reply).

### `ReplacementRow` — interface

```ts
export interface ReplacementRow {
  id: string
  workspace_id: string
  status: string
  original_order_id: string | null
  replacement_order_id: string | null
  shopify_replacement_order_name: string | null
  items: unknown
  created_at: string
}
```

Shape of a `replacements` row that this library reasons about. Kept minimal — only the fields we actually need — so callers can pass a projection from either a Supabase select or a test fixture.

### `isReplacementStalled` — function

```ts
export function isReplacementStalled(
  row: ReplacementRow,
  now: Date,
  thresholdDays: number = DEFAULT_STALL_THRESHOLD_DAYS,
): boolean
```

Pure predicate — is this replacement stalled?

A row is stalled when:
- status === 'address_confirmed', AND
- replacement_order_id is null AND shopify_replacement_order_name is null (the Shopify draft-order call never completed), AND
- it was created more than `thresholdDays` ago.

### `isSupersededBy` — function

```ts
export function isSupersededBy(
  stalled: ReplacementRow,
  later: ReplacementRow[],
): boolean
```

Pure predicate — does this later replacement fully supersede the stalled one?

A stalled row `stalled` is superseded by a later row `later` when:
- same workspace + same original_order_id (both non-null), AND
- later.created_at is strictly after stalled.created_at, AND
- later.status is a shipped/created/completed terminal (a `failed`/`denied`/`pending` sibling can't supersede — the customer got no goods from those states), AND
- later.shopify_replacement_order_name is present OR later.replacement_order_id is present, AND
- the item VARIANT SET of `later` covers the item VARIANT SET of `stalled` (every variant in the stalled cart shipped in the later order).

### `listStalledReplacements` — async function

```ts
export async function listStalledReplacements(
  admin: Admin,
  workspaceId: string,
  opts: { now?: Date; thresholdDays?: number } = {},
): Promise<ReplacementRow[]>
```

Read-only DB query — return every replacement in a workspace that is currently stalled. Callers surface these (Improve card, alert, ops dashboard) so the 17-day rot cannot recur silently.

### `applySupersede` — async function

```ts
export async function applySupersede(
  admin: Admin,
  args: { workspaceId: string; replacementId: string; supersededByReplacementId: string | null },
): Promise<boolean>
```

Compare-and-set writer — flip a stalled row to `superseded`. Guarded by workspace_id + id + status='address_confirmed' so a raced or already-terminal row cannot be overwritten. Returns `true` iff exactly one row transitioned.

## Callers

_No internal callers found via static scan._

## Gotchas

- **Stall detection must surface, not rot silently.** A replacement stuck at address_confirmed with no replacement_order_id for >7 days (default threshold) cannot be left unmonitored. Callers use [[#listStalledReplacements]] to feed an Improve card, alert, or ops dashboard so tickets like Evan H.'s 17-day rot surface immediately.

- **Supersede requires full variant coverage.** A later replacement supersedes a stalled one only if its items cover ALL variants in the stalled cart — e.g., SC132221's Peach Mango + Strawberry Lemonade was superseded only after BOTH tabs shipped in SC134462 + SC134463 (two single-item orders together). A partial shipment does not supersede.

- **Supersede is compare-and-set guarded.** The [[#applySupersede]] write only succeeds if the row is still `address_confirmed` + in the same workspace — a raced concurrent update or an already-terminal row (failed/denied/created) cannot be overwritten. No silent overwrites.

## Status / open work

**Shipped:** Stalled replacement detection and first-class `superseded` terminal status (Phase 3).
- `isReplacementStalled` / `isSupersededBy` predicates tested and unit-verified.
- `listStalledReplacements` queries stalled rows in a workspace.
- `applySupersede` transitively flip address_confirmed rows to superseded.
- `superseded` status renders in the UI (ReplacementsList.tsx).

**Known gaps / not yet shipped:**
- None

**Recent activity:**
- Stall detection integrated with replacement reconciliation workflow

**Open questions:** None

---

[[../README]] · [[../../CLAUDE]]
