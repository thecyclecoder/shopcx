# libraries/access

Per-route role gating helpers (`requireRole()`).

**File:** `src/lib/access.ts`

## Exports

### `isAdminEmail` — function

```ts
function isAdminEmail(email: string) : boolean
```

### `isAuthorizedUser` — function

```ts
async function isAuthorizedUser(email: string) : Promise<boolean>
```

Checks if an email has authorization (admin, invited, or a workspace member). Uses a targeted RPC lookup instead of a full auth.users scan (see Hot-path auth optimization below).

### `isAuthorizedUserId` — function

```ts
async function isAuthorizedUserId(userId: string) : Promise<boolean>
```

Checks if a user ID is authorized by looking up their email and calling `isAuthorizedUser`.

## Hot-path auth optimization

**Before:** `isAuthorizedUser` called `admin.auth.admin.listUsers()` with client-side filtering. The Supabase API paginates at 50 rows per page, so any user whose ID sorted past the first 50 in auth.users was silently denied (broken auth).

**Now:** Uses a targeted RPC `get_user_id_by_email` to fetch only the matching user ID, then verifies with `admin.auth.admin.getUserById(userId)`. Eliminates the full-table scan and fixes the pagination bug.

**Affected routes:** Similar patterns applied across enrichment routes that previously called `admin.auth.admin.listUsers()` to populate user display names:
- `src/app/api/tickets/route.ts` (GET) — enriches assigned user names from [[../tables/workspace_members]] instead of auth.users
- `src/app/api/tickets/[id]/route.ts` (GET) — same enrichment pattern
- `src/app/api/workspaces/[id]/members/route.ts` (GET) — uses workspace_members for display_name, getUserById only when email is needed
- `src/app/api/workspaces/[id]/invite/route.ts` — similar targeted queries

**Key pattern:** Always prefer [[../tables/workspace_members]].display_name for user-facing labels; use `admin.auth.admin.getUserById()` only when a specific field from auth.users (e.g. email) is actually needed.

## Callers

- `src/app/auth/callback/route.ts`

## Gotchas

- Use `getUserById()` sparingly in hot paths — it's per-user, so a loop over N users queries N times. Pre-fetch user metadata into [[../tables/workspace_members]] or a response-scoped cache when possible.
- `listUsers()` never fetches all users — it silently paginates at 50. Never call it with the assumption it's complete. Use targeted queries (`rpc("get_user_id_by_email", ...)` or direct auth lookup) instead.

---

[[../README]] · [[../../CLAUDE]]
