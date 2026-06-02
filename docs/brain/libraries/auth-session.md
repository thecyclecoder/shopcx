# libraries/auth-session

Server-side auth session helpers (workspace resolution, user fetch).

**File:** `src/lib/auth-session.ts`

## File header

```
Signed `sx_session` cookie for the storefront customer session.
Set after a successful OTP verify (or magic-link click). Used by:
• /api/checkout/client-token to bind the Braintree drop-in to
the customer's vaulted cards
• /api/checkout/* to autofill addresses + recognize the customer
• the portal at /portal/* to skip the login step
Cookie format: `<base64url(payload)>.<hmacSha256(payload, secret)>`
payload = { w: workspace_id, c: customer_id, exp: unix-seconds }
Lifetime: 7 days. Cookie attributes: HttpOnly, Secure (in prod),
SameSite=Lax, Path=/.
```

## Exports

### `buildSessionToken` — function

```ts
function buildSessionToken(workspaceId: string, customerId: string) : string
```

### `verifySessionToken` — function

```ts
function verifySessionToken(token: string | null | undefined) : SessionPayload | null
```

### `setSessionCookie` — function

```ts
function setSessionCookie(res: NextResponse, workspaceId: string, customerId: string) : void
```

### `readSessionFromCookies` — function

```ts
async function readSessionFromCookies() : Promise<SessionPayload | null>
```

### `readSessionFromRequest` — function

```ts
function readSessionFromRequest(req: NextRequest) : SessionPayload | null
```

### `SX_SESSION_COOKIE` — const

```ts
const SX_SESSION_COOKIE
```

## Callers

- `src/app/api/checkout/client-token/route.ts`
- `src/app/api/checkout/existing-subs/route.ts`
- `src/app/api/checkout/otp/verify/route.ts`
- `src/app/api/checkout/payment-methods/route.ts`
- `src/app/api/portal/otp/verify/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
