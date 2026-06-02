# inngest/marketing-coupon-cron

Auto-disables expired SMS-campaign coupons in Shopify `coupon_expires_days_after_send` days after first send.

**File:** `src/lib/inngest/marketing-coupon-cron.ts`

## Functions

### `marketing-coupon-auto-disable`
- **Trigger:** event `marketing/coupon.disable-tick`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/sms_campaigns]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
