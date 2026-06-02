# inngest/sms-wave-promote

Promotes the next wave of `sms_send_candidates` into `sms_campaign_recipients` based on archetype + replenishment ratio.

**File:** `src/lib/inngest/sms-wave-promote.ts`

## Functions

### `sms-wave-promote`
- **Trigger:** event `marketing/sms-wave.promote`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.wave_key" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/sms_campaign_recipients]]
- [[../tables/sms_campaigns]]
- [[../tables/sms_send_candidates]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
