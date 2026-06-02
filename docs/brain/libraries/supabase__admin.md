# libraries/supabase/admin

Service-role Supabase client (`createAdminClient()`). All server-side writes use this.

**File:** `src/lib/supabase/admin.ts`

## Exports

### `createAdminClient` — function

```ts
function createAdminClient()
```

## Callers

- `src/app/(storefront)/_lib/page-data.ts`
- `src/app/(storefront)/_lib/storefront-metadata.ts`
- `src/app/(storefront)/checkout/page.tsx`
- `src/app/(storefront)/customize/page.tsx`
- `src/app/(storefront)/policies/[slug]/page.tsx`
- `src/app/(storefront)/thank-you/page.tsx`
- `src/app/api/auth/google-ads/callback/route.ts`
- `src/app/api/auth/google-ads/route.ts`
- `src/app/api/cart/route.ts`
- `src/app/api/chargebacks/[id]/cancel-subscription/route.ts`
- `src/app/api/chargebacks/[id]/reinstate/route.ts`
- `src/app/api/chargebacks/[id]/subscriptions/route.ts`
- `src/app/api/chargebacks/route.ts`
- `src/app/api/chargebacks/settings/route.ts`
- `src/app/api/chargebacks/stats/route.ts`
- `src/app/api/checkout/client-token/route.ts`
- `src/app/api/checkout/existing-subs/route.ts`
- `src/app/api/checkout/identify/route.ts`
- `src/app/api/checkout/otp/resend/route.ts`
- `src/app/api/checkout/otp/start/route.ts`
- … and 444 more

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
