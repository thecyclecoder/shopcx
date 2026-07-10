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
- `src/lib/workflow-executor.ts` — the `account_login` workflow mints a 24h login link for the matched/linked customer.
- `src/lib/improve-actions.ts` — the Improve `send_magic_link` action re-sends a 24h login link to the ticket's **current** on-file customer email (approval-gated; pairs after `reassign_ticket_customer`). See [[orchestrator-tools]] § Improve parity.
- `src/lib/investors/auth.ts` — `generateInvestorMagicLink` reuses `generateMagicToken` (40-day TTL) for the investors area entry link (`/investors/enter?token=…`). See [[investors-auth]] + [[../lifecycles/investors-area]].

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
