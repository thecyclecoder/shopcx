# libraries/crypto

AES-256-GCM `encrypt()` / `decrypt()`. Uses `ENCRYPTION_KEY` env (64-char hex). Every `*_encrypted` column on [[../tables/workspaces]] goes through this.

**File:** `src/lib/crypto.ts`

## Exports

### `encrypt` — function

```ts
function encrypt(plaintext: string) : string
```

### `decrypt` — function

```ts
function decrypt(encrypted: string) : string
```

## Callers

- `src/app/api/auth/google-ads/callback/route.ts`
- `src/app/api/customers/[id]/payment-methods/route.ts`
- `src/app/api/meta/ads-callback/route.ts`
- `src/app/api/meta/callback/route.ts`
- `src/app/api/portal/multipass-login/route.ts`
- `src/app/api/portal/route.ts`
- `src/app/api/shopify/auth/route.ts`
- `src/app/api/shopify/callback/route.ts`
- `src/app/api/tickets/[id]/messages/route.ts`
- `src/app/api/tickets/[id]/share/route.ts`
- `src/app/api/webhooks/amplifier/route.ts`
- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/app/api/webhooks/easypost/route.ts`
- `src/app/api/webhooks/email/route.ts`
- `src/app/api/workspaces/[id]/amazon/pricing/route.ts`
- `src/app/api/workspaces/[id]/amazon/route.ts`
- `src/app/api/workspaces/[id]/integrations/amplifier/webhooks/route.ts`
- `src/app/api/workspaces/[id]/integrations/avalara/verify/route.ts`
- `src/app/api/workspaces/[id]/integrations/braintree/verify/route.ts`
- `src/app/api/workspaces/[id]/integrations/route.ts`
- … and 47 more

## Gotchas

- Encryption key is 64-char hex in `ENCRYPTION_KEY` env. Wrong length → decrypt fails silently.
- Don't re-encrypt already-encrypted strings. Caller must know if a value is plain or encrypted.

---

[[../README]] · [[../../CLAUDE]]
