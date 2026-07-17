# libraries/supabase/server

SSR Supabase client for server components.

**File:** `src/lib/supabase/server.ts`

## Exports

### `createClient` — function

```ts
async function createClient()
```

### `getAuthedUser` — function

```ts
async function getAuthedUser(opts?: { fresh?: boolean }): Promise<{ user: AuthedUser | null }>
```

Tag: `db-load-route-auth-helper`. Shared auth entrypoint for API-route handlers
(`src/app/api/**/route.ts`). Wraps `createClient()` + `supabase.auth.getClaims()`
so the JWT is verified locally against the cached JWKS with zero auth-table
reads per request (falls back to `getUser()` internally on legacy HS256 keys).
Returns the same `{ user }` shape routes already read via
`const { data: { user } } = await supabase.auth.getUser()` — all 528 routes
are migrated to this helper (see [[../archive.d/db-load-route-auth-getclaims-codemod]])
via a mechanical `const { user } = await getAuthedUser()` swap. Pass `{ fresh: true }` when the
route needs a User field not present in the JWT payload (falls back to the
server-side `getUser()` for that one call site).

Distinct from the same-named `getAuthedUser` in [[auth]] (`src/lib/auth.ts`,
tag `db-load-auth-cache`) which is a React `cache()`-wrapped `getUser()` gate
for dashboard SSR + workspace resolution — that helper deliberately stays on
`getUser()` for authz freshness. This one is the API-route replacement.

## Callers

- `src/app/api/auth/google-ads/callback/route.ts`
- `src/app/api/auth/google-ads/route.ts`
- `src/app/api/chargebacks/[id]/cancel-subscription/route.ts`
- `src/app/api/chargebacks/[id]/reinstate/route.ts`
- `src/app/api/chargebacks/[id]/subscriptions/route.ts`
- `src/app/api/chargebacks/route.ts`
- `src/app/api/chargebacks/settings/route.ts`
- `src/app/api/chargebacks/stats/route.ts`
- `src/app/api/customers/[id]/enrich/route.ts`
- `src/app/api/customers/[id]/events/route.ts`
- `src/app/api/customers/[id]/links/route.ts`
- `src/app/api/customers/[id]/payment-methods/route.ts`
- `src/app/api/customers/[id]/portal-ban/route.ts`
- `src/app/api/customers/[id]/route.ts`
- `src/app/api/customers/[id]/suggestions/route.ts`
- `src/app/api/customers/route.ts`
- `src/app/api/invites/[id]/accept/route.ts`
- `src/app/api/loyalty/members/[memberId]/route.ts`
- `src/app/api/loyalty/members/route.ts`
- `src/app/api/loyalty/redeem/route.ts`
- … and 221 more

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
