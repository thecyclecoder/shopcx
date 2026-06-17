# libraries/magic-link

Magic-link auth for passwordless dashboard login.

**File:** `src/lib/magic-link.ts`

## File header

```
Magic Link system for portal login.
Generates signed, time-limited tokens that auto-log customers into the portal.
Replaces Shopify Multipass (which doesn't work with new customer accounts).
```

## Exports

### `generateMagicToken` — function

```ts
function generateMagicToken(customerId: string, shopifyCustomerId: string, email: string, workspaceId: string,) : string
```

### `verifyMagicToken` — function

```ts
function verifyMagicToken(token: string) : MagicLinkPayload | null
```

### `generateMagicLinkURL` — function

```ts
async function generateMagicLinkURL(customerId: string, shopifyCustomerId: string, email: string, workspaceId: string,) : Promise<string>
```

## Callers

- `src/app/api/portal/magic-login/route.ts` — verifies the token, sets the session cookie.
- `src/lib/portal/handlers/sso.ts` — Shopify App-Proxy SSO mints `generateMagicLinkURL` from the verified `logged_in_customer_id` and 302s into the portal. See [[portal__handlers__sso]].
- `src/lib/inngest/*` payment-recovery — `generatePaymentRecoveryLink` (7-day token → `/payment-methods?recover=1`).

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
