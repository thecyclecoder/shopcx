# libraries/portal/helpers

Portal response helpers, event logging, Appstle error wrapping.

**File:** `src/lib/portal/helpers.ts`

## Exports

### `jsonOk` — function

```ts
function jsonOk(body: Record<string, unknown>, status = 200)
```

### `jsonErr` — function

```ts
function jsonErr(body: Record<string, unknown>, status = 400)
```

### `clampInt` — function

```ts
function clampInt(n: unknown, fallback: number) : number
```

### `shortId` — function

```ts
function shortId(gid: unknown) : string
```

### `addDaysFromNow` — function

```ts
function addDaysFromNow(days: number) : string
```

### `findCustomer` — function

```ts
async function findCustomer(workspaceId: string, shopifyCustomerId: string)
```

### `logPortalAction` — function

```ts
async function logPortalAction(params: { workspaceId: string; customerId: string; eventType: string; summary: string; properties?: Record<string, unknown>; createNote?: boolean; })
```

### `checkPortalBan` — function

```ts
async function checkPortalBan(workspaceId: string, shopifyCustomerId: string)
```

### `handleAppstleError` — function

```ts
function handleAppstleError(e: unknown, context?: { route?: string; payload?: unknown }) : NextResponse
```

## Callers

- `src/app/api/portal/route.ts`
- `src/lib/portal/handlers/account.ts`
- `src/lib/portal/handlers/address.ts`
- `src/lib/portal/handlers/ban-request.ts`
- `src/lib/portal/handlers/bootstrap.ts`
- `src/lib/portal/handlers/cancel-journey.ts`
- `src/lib/portal/handlers/cancel.ts`
- `src/lib/portal/handlers/change-date.ts`
- `src/lib/portal/handlers/coupon.ts`
- `src/lib/portal/handlers/dunning-status.ts`
- `src/lib/portal/handlers/frequency.ts`
- `src/lib/portal/handlers/home.ts`
- `src/lib/portal/handlers/link-accounts.ts`
- `src/lib/portal/handlers/loyalty-apply-subscription.ts`
- `src/lib/portal/handlers/loyalty-balance.ts`
- `src/lib/portal/handlers/loyalty-redeem.ts`
- `src/lib/portal/handlers/order-now.ts`
- `src/lib/portal/handlers/pause.ts`
- `src/lib/portal/handlers/payment-methods.ts`
- `src/lib/portal/handlers/reactivate.ts`
- … and 7 more

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
