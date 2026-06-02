# libraries/marketing-coupons

Coupon code resolution by VIP tier from [[../tables/coupon_mappings]]. Used by discount-signup journey.

**File:** `src/lib/marketing-coupons.ts`

## File header

```
Marketing campaign coupons. One shared discount code per campaign
(e.g. MAYBLAST20) issued in Shopify via discountCodeBasicCreate at
schedule time, then disabled in Shopify by a daily cron once the
campaign's coupon_expires_days_after_send window closes.
Code format: campaign-name-stem (uppercased, 3-8 chars) + 2 digit
random suffix. Falls back to a 6-char random Crockford-base32 if
the name yields a poor stem (e.g. all symbols).
```

## Exports

### `createCampaignCoupon` — function

```ts
async function createCampaignCoupon(input: CampaignCouponInput,) : Promise<CampaignCouponResult>
```

### `disableCampaignCoupon` — function

```ts
async function disableCampaignCoupon(workspaceId: string, shopifyNodeId: string,) : Promise<
```

### `generateCampaignCode` — function

```ts
function generateCampaignCode(campaignName: string) : string
```

### `buildShortlinkUrl` — function

```ts
async function buildShortlinkUrl(workspaceId: string, slug: string,) : Promise<string | null>
```

## Callers

- `src/lib/inngest/marketing-coupon-cron.ts`
- `src/lib/inngest/marketing-text.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
