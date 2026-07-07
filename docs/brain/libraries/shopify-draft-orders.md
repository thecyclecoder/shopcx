# libraries/shopify-draft-orders

Draft order create + complete. Used by replacement-order playbook + storefront cart-bridge legacy path.

**File:** `src/lib/shopify-draft-orders.ts`

## File header

```
Shopify Draft Order creation for replacement orders
Creates $0 draft orders using 100% discount, then completes them
```

## Exports

### `createReplacementDraftOrder` — function

```ts
async function createReplacementDraftOrder(workspaceId: string, input: ReplacementOrderInput,) : Promise<CreatedDraftOrder>
```

### `completeDraftOrder` — function

```ts
async function completeDraftOrder(workspaceId: string, draftOrderId: string,) : Promise<CompletedReplacementOrder>
```

### `createAndCompleteReplacement` — function

```ts
async function createAndCompleteReplacement(workspaceId: string, input: ReplacementOrderInput,) : Promise<CompletedReplacementOrder>
```

### `ReplacementLineItem` — interface

### `ReplacementOrderInput` — interface

### `CreatedDraftOrder` — interface

### `CompletedReplacementOrder` — interface

## Callers

- `src/app/api/workspaces/[id]/replacements/[replacementId]/route.ts`

## Gotchas

- **Shopify throttling is retried transparently.** The internal `shopifyGraphQL`
  helper retries HTTP 429/5xx **and** the sneaky HTTP-200-with-`errors:[{code:
  "THROTTLED"}]`-and-no-`data` response, with exponential backoff (500ms → 4s,
  4 attempts). Before this, a 200+THROTTLED body was returned verbatim, callers
  saw `data.draftOrderCreate === undefined`, and threw a generic
  `"Draft order creation returned no data"` — discarding the real reason. This
  stranded a legitimate replacement on ticket `332f4509` (2026-07-03).
- **Non-throttle top-level GraphQL errors are surfaced, not swallowed.** A
  non-retryable `errors` array is thrown as `Shopify GraphQL error: <message>`,
  so the failure reason reaches logs / the ticket escalation note. The
  `"returned no data" / "returned no order"` throws now also echo the raw
  payload (first 500 chars) as a last-resort diagnostic.
- **`countryCode` must be ISO-2, not full country name.** Shopify's draft order
  `countryCode` field expects ISO-2 codes ('US', 'CA', 'GB') and rejects full
  names ('United States', 'Canada'). The code normalizes at lines ~183 and ~316
  to map 'United States'/'USA'/'US' → 'US', territories (PR/GU/VI/AS/MP) →
  'US', and non-US full names → ISO-2 with 'US' fallback. Grounded in ticket
  SC132896 (Catherine Green — carrier-lost replacement that failed when
  countryCode was 'United States'). Cross-linked with [[replacement-order]].

## Status / open work

**Shipped:** Country code normalization in draft order creation (Phase 1).
All code paths that build Shopify shipping addresses now send ISO-2 codes.

**Known gaps / not yet shipped:**
- None

**Recent activity:**
- Country code normalization landed in createReplacementDraftOrder and
  createAndCompleteReplacement code paths

**Open questions:** None

---

[[../README]] · [[../../CLAUDE]]
