# libraries/auth

Per-request React `cache()`-wrapped auth + workspace-membership accessors. One server render resolves the user once (via `supabase.auth.getUser()` — fresh server-side validation) and reads `workspace_members` once per userId, instead of the 2–3 GoTrue re-auths (each = 5 auth-table reads) + 3 `workspace_members` reads the dashboard used to do.

**File:** `src/lib/auth.ts`

## Why

`pg_stat_statements` showed Supabase GoTrue auth as the top DB-load lever left after the usage-rollup throttle — ~14,050 calls/hr (9.6% of all DB calls). Each `supabase.auth.getUser()` fans out to five auth-table reads (sessions + mfa_amr_claims + mfa_factors + identities + users). A single dashboard render was authenticating 2–3× (middleware gate, dashboard layout, workspace resolution) and reading `workspace_members` three times. Two orthogonal reductions:

1. **`db-load-auth-cache`** — React `cache()` dedups repeated `getAuthedUser` / `getWorkspaceMemberships` calls within one server render pass with zero behavior change. This applies here.
2. **`db-load-getclaims`** — `supabase.auth.getClaims()` (local JWT verify against a once-fetched, in-memory-cached JWKS on asymmetric signing keys — zero auth-table reads) is used at the middleware site only (see [[../lifecycles/middleware-and-domain-routing]] via `src/lib/supabase/middleware.ts`). It is intentionally NOT used by this accessor — see the security-gate note below.

## `getClaims()` is coarse; this accessor gates authz — Phase 3 / Fix 1 note

`getAuthedUser` in this library returns fresh-validated `getUser()` because its two callers are authz gates that must not accept a signed-but-revoked JWT until natural expiry:

- `src/app/dashboard/layout.tsx` — the protected dashboard SSR's login gate.
- `src/lib/workspace.ts` `getActiveWorkspaceId` — the `app_metadata.workspace_id` fallback drives service-role dashboard reads (e.g. `src/app/dashboard/storefront/blog/page.tsx`).

The middleware swap to `getClaims()` remains in place: the middleware gate is coarse ("logged in? redirect to `/login`" + admin-email check), and the fine-grained per-request authz happens downstream in this accessor. This split is precisely what Phase 2's language anticipated ("Any site that genuinely needs a freshly-server-validated full user object stays on getUser()"); the pre-merge spec-test's `blocker:real_blocker` finding confirmed that dashboard layout + workspace helpers are such sites.

## Exports

### `getAuthedUser` — function

```ts
const getAuthedUser: () => Promise<{ user: User | null; error: AuthError | null }>
```

React `cache()`-wrapped `supabase.auth.getUser()`. Repeated calls within one server render return the same promise (`db-load-auth-cache`).

### `getWorkspaceMemberships` — function

```ts
const getWorkspaceMemberships: (userId: string) => Promise<{ workspace_id: string; role: string }[]>
```

React `cache()`-wrapped `workspace_members` read keyed by `userId`. Used by [[workspace]] `getActiveWorkspaceId` (single-workspace auto-select) and `setActiveWorkspace` (membership verify) so they don't re-hit the table when a sibling caller already did.

## Callers

- `src/app/dashboard/layout.tsx` — via `getAuthedUser`.
- `src/lib/workspace.ts` — `getActiveWorkspaceId` uses `getAuthedUser` + `getWorkspaceMemberships`; `setActiveWorkspace` uses `getWorkspaceMemberships`.
- `src/lib/supabase/middleware.ts` — inlines the `db-load-getclaims` swap directly (mapping `claims.sub`/`email`/`app_metadata` into a local `user` shape); does NOT go through this accessor. The 2s `Promise.race` timeout the previous `getUser()` needed is dropped for the getClaims path (local verify has no upstream to hang on).

## Gotchas

- `cache()` only dedups within a single server render/request. Different requests each resolve the auth exactly once.
- No auth semantics change. Every redirect + authorization branch is preserved.
- If you add a new authz-critical caller, route it through `getAuthedUser` (getUser-backed) — do NOT swap this accessor to `getClaims()`. The middleware swap is safe because its gate is coarse; adding a fine-grained authz gate on top of `getClaims()` would accept revoked-but-not-yet-expired tokens.

---

[[../README]] · [[../../CLAUDE]]
