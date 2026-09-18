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

### `isLwaCredentialsExpiredError` — function

```ts
function isLwaCredentialsExpiredError(err: unknown): boolean
```

Classifies an error thrown from the SP-API request path (LWA token exchange in `getAccessToken`, or a downstream SP-API 401 whose body carries the same signature) as "the stored LWA client_secret has expired and needs the workspace owner to rotate it". Returns true when the error is an `Error` whose message contains **`LWA secret token you provided has expired`** (the SP-API 401 body) or **`LWA token exchange failed`** (the prefix `getAccessToken` throws when the LWA refresh call itself 4xxs). Consumed by [[../inngest/amazon-sync]] `amazon-sync-orders`, which catches around `requestReport`, deactivates the connection, and files a dashboard notification instead of retry-storming on the dead credential.

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
