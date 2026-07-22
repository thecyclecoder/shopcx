# libraries/amazon/auth

Amazon SP-API OAuth + token refresh.

**File:** `src/lib/amazon/auth.ts`

## File header

```
Amazon SP-API authentication + request helper
Uses LWA OAuth with refresh token, caches access tokens in DB
```

## Exports

### `getAccessToken` — function

```ts
async function getAccessToken(connectionId: string) : Promise<string>
```

### `getSpApiEndpoint` — function

```ts
function getSpApiEndpoint(marketplaceId: string) : string
```

### `spApiRequest` — function

```ts
async function spApiRequest(connectionId: string, marketplaceId: string, method: string, path: string, body?: unknown,) : Promise<Response>
```

## Callers

- `src/app/api/workspaces/[id]/amazon/pricing/route.ts`
- `src/app/api/workspaces/[id]/amazon/route.ts`
- `src/lib/inngest/amazon-sync.ts`
- `src/lib/known-resellers.ts`

## Gotchas

- `spApiRequest` is a **generic** SP-API caller (any method/path) — not read-only. It's the write path behind [[../recipes/amazon-listing-copy-update]] (Listings Items API PATCH). Writes need the app's LWA token to carry the relevant SP-API role (e.g. **Product Listing** for listing edits) or the call returns 403.
- The Listings Items API keys on **seller SKU**, not ASIN — resolve via [[../tables/amazon_asins]] first.

## Recipes

- [[../recipes/amazon-listing-copy-update]] — rewrite a listing's title/bullets/description (prohibited-claim cleanup).

---

[[../README]] · [[../../CLAUDE]]
