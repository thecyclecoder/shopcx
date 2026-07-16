# libraries/auth

Per-request React `cache()`-wrapped auth + workspace-membership accessors. One server render resolves the user once (via local JWT verify when the project uses asymmetric signing keys) and reads `workspace_members` once per userId, instead of the 2–3 GoTrue re-auths (each = 5 auth-table reads) + 3 `workspace_members` reads the dashboard used to do.

**File:** `src/lib/auth.ts`

## Why

`pg_stat_statements` showed Supabase GoTrue auth as the top DB-load lever left after the usage-rollup throttle — ~14,050 calls/hr (9.6% of all DB calls). Each `supabase.auth.getUser()` fans out to five auth-table reads (sessions + mfa_amr_claims + mfa_factors + identities + users). A single dashboard render was authenticating 2–3× (middleware gate, dashboard layout, workspace resolution) and reading `workspace_members` three times. Two orthogonal reductions:

1. **`db-load-auth-cache`** — React `cache()` dedups repeated `getAuthedUser` / `getWorkspaceMemberships` calls within one server render pass with zero behavior change.
2. **`db-load-getclaims`** — the accessor calls `supabase.auth.getClaims()` (local JWT verify against a once-fetched, in-memory-cached JWKS on asymmetric signing keys — zero auth-table reads) instead of `getUser()`. On legacy HS256 keys `getClaims` internally falls back to `getUser`, so the swap is regression-safe before the key migration and becomes a full elimination the moment the project flips to asymmetric keys (a zero-downtime Supabase dashboard toggle, not a code change).

Both tags are greppable — `db-load-auth-cache` marks the cache-wrapped call sites, `db-load-getclaims` marks the middleware swap + this accessor.

## Exports

### `getAuthedUser` — function

```ts
const getAuthedUser: () => Promise<{ user: ClaimsUser | null; error: AuthError | null }>
```

React `cache()`-wrapped `supabase.auth.getClaims()`. Repeated calls within one server render return the same promise. `ClaimsUser` is `{ id, email, app_metadata, user_metadata }` mapped from the JWT payload (`claims.sub` → `id`, plus `claims.email` / `claims.app_metadata` / `claims.user_metadata`). Miss behaves exactly like a bare `getClaims()` — which itself falls back to `getUser()` on legacy HS256, so no regression before the asymmetric-key migration.

### `getWorkspaceMemberships` — function

```ts
const getWorkspaceMemberships: (userId: string) => Promise<{ workspace_id: string; role: string }[]>
```

React `cache()`-wrapped `workspace_members` read keyed by `userId`. Used by [[workspace]] `getActiveWorkspaceId` (single-workspace auto-select) and `setActiveWorkspace` (membership verify) so they don't re-hit the table when a sibling caller already did.

## Callers

- `src/app/dashboard/layout.tsx` — via `getAuthedUser`
- `src/lib/workspace.ts` — `getActiveWorkspaceId` uses `getAuthedUser` + `getWorkspaceMemberships`; `setActiveWorkspace` uses `getWorkspaceMemberships`
- `src/lib/supabase/middleware.ts` — inlines the same `db-load-getclaims` swap (mapping `claims.sub`/`email`/`app_metadata` into a local `user` shape); the 2s `Promise.race` timeout the previous `getUser()` call needed is dropped for the getClaims path (local verify has no upstream to hang on).

## Gotchas

- `cache()` only dedups within a single server render/request. Different requests each resolve the auth exactly once.
- No auth semantics change. Every redirect + authorization branch is preserved. On legacy HS256 keys `getClaims()` internally round-trips to GoTrue (same 5 auth-table reads as `getUser()`) — the elimination lands only after the project flips to asymmetric signing keys.
- Activation step (Supabase dashboard toggle to asymmetric JWT keys) is captured in the spec's human-review note, NOT a code change.

---

[[../README]] · [[../../CLAUDE]]
