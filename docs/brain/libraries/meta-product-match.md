# libraries/meta-product-match

Match comment text → product UUID via embeddings + Haiku. Returns canonical product URL.

**File:** `src/lib/meta-product-match.ts`

## File header

```
Match URLs found in a Meta post / ad to a `products` row by handle.
Strategy:
1. Direct match — if the host is the workspace's storefront domain
(or `shopify_domain`), extract the path's first segment and look
it up as `products.handle`.
2. Known shortlink hosts (bit.ly, linktr.ee, lnk.bio, sprfd.co) →
follow ONE redirect with a short timeout and try again. We don't
chain — multi-hop shortlinks are rare and the cost grows fast.
3. First match wins. No match → null.
Designed to be cheap: no DB writes, no Graph API calls. The caller
(post cache hydrator) is the one that persists the result.
```

## Exports

### `resolvePostProductMatch` — function

```ts
async function resolvePostProductMatch(admin: Admin, workspaceId: string, urls: string[],) : Promise<string | null>
```

### `matchPostToProductViaAI` — function

```ts
async function matchPostToProductViaAI(admin: Admin, workspaceId: string, postMessage: string,) : Promise<string | null>
```

## Callers

- `src/lib/social-comment-ingest.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
