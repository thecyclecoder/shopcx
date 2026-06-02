# libraries/meta/api

Marketing API client (campaigns, ad sets, insights, creatives).

**File:** `src/lib/meta/api.ts`

## Exports

### `getMetaAccountId` — function

```ts
function getMetaAccountId(id: string) : string
```

### `metaGraphRequest` — function

```ts
async function metaGraphRequest(accessToken: string, path: string, params?: Record<string, string>,) : Promise<unknown>
```

### `getMetaAdsLoginUrl` — function

```ts
function getMetaAdsLoginUrl(workspaceId: string) : string
```

### `exchangeCodeForToken` — function

```ts
async function exchangeCodeForToken(code: string) : Promise<
```

## Callers

- `src/app/api/meta/ads-callback/route.ts`
- `src/app/api/workspaces/[id]/meta-ads/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
