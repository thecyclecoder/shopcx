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

_None documented._

---

[[../README]] · [[../../CLAUDE]]
