# libraries/portal/handlers/bootstrap

Portal bootstrap — loads customer + workspace branding + journey enablement.

**File:** `src/lib/portal/handlers/bootstrap.ts`

## Exports

### `bootstrap` — const

```ts
const bootstrap: RouteHandler
```

### `withBootstrapTimeout` — fn

```ts
export async function withBootstrapTimeout<T>(
  work: Promise<T>,
  fallback: T,
  timeoutMs?: number,
): Promise<T>
```

Soft-deadline wrapper for optional bootstrap enrichments. If `work` exceeds
`timeoutMs` (default: `PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS`), resolves to
`fallback` instead of blocking the response. Resolves to the actual value if
`work` completes in time. Errors in `work` resolve to `fallback`, never
propagate.

### `PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS` — const

```ts
export const PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS = 4000
```

Soft deadline (4 seconds) for noncritical bootstrap enrichments. The portal
/api/portal endpoint runs under Vercel's 30-second Lambda timeout; before this
constant, any slow optional read (catalog decoration, unlinked-account matching)
held the entire response until Vercel hard-killed the Lambda. Now, optional
reads wrapped in `withBootstrapTimeout` degrade to empty/zero fallbacks on
timeout, so customers get a usable core portal instead of a 30-second timeout.

## Callers

_No internal callers found via static scan._

## Gotchas

- **Catalog filter runs the suppressed-variant set.** After loading the
  workspace's products, bootstrap drops any variant whose id appears in
  `workspaces.portal_config.suppressed_variant_ids` (via
  [[portal__mutation-guard]] `getSuppressedVariantIds`) BEFORE the
  `inventory_quantity > 0` filter — so a variant that is IN STOCK but pulled
  off the portal for a crisis availability lever (e.g. SL) never surfaces in
  the swap/add UI. Products that end up with zero visible variants drop out
  of the catalog entirely.
- **Optional enrichments wrapped in `withBootstrapTimeout`.** The dunning count,
  linked-account count, catalog, shipping-protection variants, and unlinked-account
  matches all run concurrently and each returns a safe fallback (0, empty array)
  if its read stalls past 4 seconds. Core reads (customer identity, workspace
  config) are NOT wrapped — a slow core read still fails the response, which is
  correct. The entire bootstrap completes within the Vercel 30-second ceiling even
  when individual optional reads stall.

---

[[../README]] · [[../../CLAUDE]]
