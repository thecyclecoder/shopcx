# libraries/auth

Per-request React `cache()`-wrapped auth + workspace-membership accessors. One server render fires Supabase `auth.getUser()` once and reads `workspace_members` once per userId, instead of the 2–3 GoTrue re-auths (each = 5 auth-table reads) + 3 `workspace_members` reads the dashboard used to do.

**File:** `src/lib/auth.ts`

## Why

`pg_stat_statements` showed Supabase GoTrue auth as the top DB-load lever left after the usage-rollup throttle — ~14,050 calls/hr (9.6% of all DB calls). Each `supabase.auth.getUser()` fans out to five auth-table reads (sessions + mfa_amr_claims + mfa_factors + identities + users). A single dashboard render was authenticating 2–3× (middleware gate, dashboard layout, workspace resolution) and reading `workspace_members` three times. React's `cache()` dedups within one render pass with zero behavior change.

Tag `db-load-auth-cache` marks the cache-wrapped call sites for grep.

## Exports

### `getAuthedUser` — function

```ts
const getAuthedUser: () => Promise<{ user: User | null; error: AuthError | null }>
```

React `cache()`-wrapped `supabase.auth.getUser()`. Repeated calls within one server render return the same promise. Miss behaves exactly like a bare `getUser()`.

### `getWorkspaceMemberships` — function

```ts
const getWorkspaceMemberships: (userId: string) => Promise<{ workspace_id: string; role: string }[]>
```

React `cache()`-wrapped `workspace_members` read keyed by `userId`. Used by [[workspace]] `getActiveWorkspaceId` (single-workspace auto-select) and `setActiveWorkspace` (membership verify) so they don't re-hit the table when a sibling caller already did.

## Callers

- `src/app/dashboard/layout.tsx` — via `getAuthedUser`
- `src/lib/workspace.ts` — `getActiveWorkspaceId` uses `getAuthedUser` + `getWorkspaceMemberships`; `setActiveWorkspace` uses `getWorkspaceMemberships`

## Gotchas

- `cache()` only dedups within a single server render/request. Different requests each fire the underlying `getUser()` and `workspace_members` reads exactly once.
- No auth semantics change. Every redirect + authorization branch is preserved.
- Phase 2 of the same spec swaps the middleware `getUser()` to `getClaims()` (local JWT verify) — that eliminates the round-trip entirely on asymmetric keys. This library is orthogonal (per-request dedup, not local-verify).

---

[[../README]] · [[../../CLAUDE]]
