# inngest/klaviyo-attribution-compute

Recomputes `klaviyo_sms_campaign_history.initial_revenue_cents` by joining Placed Orders via `attributed_klaviyo_campaign_id`.

**File:** `src/lib/inngest/klaviyo-attribution-compute.ts`

## Functions

### `klaviyo-attribution-compute`
- **Trigger:** event `marketing/klaviyo-attribution.compute`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/klaviyo_sms_campaign_history]]

## Tables read (not written)

- [[../tables/klaviyo_events]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
