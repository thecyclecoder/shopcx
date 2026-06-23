# inngest/marketing-coupon-cron

Auto-disables expired SMS-campaign coupons in Shopify `coupon_expires_days_after_send` days after first send.

**File:** `src/lib/inngest/marketing-coupon-cron.ts`

## Functions

### `marketing-coupon-auto-disable`
- **Trigger:** cron `0 10 * * *` (5 AM Central daily) + event `marketing/coupon.disable-tick`
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Control Tower heartbeat:** emits `emitCronHeartbeat("marketing-coupon-auto-disable")` on **every** successful run, including the no-work (`due.length === 0`) path. There is no early return before the heartbeat step — a healthy-but-idle cron (0 active-coupon campaigns) still beats, so the watchdog never false-flags it `registered_not_firing`. See [[../specs/control-tower]].


## Downstream events sent

_None._

## Tables written

- [[../tables/sms_campaigns]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
