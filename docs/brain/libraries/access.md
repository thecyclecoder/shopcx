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

### `isAuthorizedUserId` — function

```ts
async function isAuthorizedUserId(userId: string) : Promise<boolean>
```

## Callers

- `src/app/auth/callback/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
