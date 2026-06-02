# inngest/marketing-text

SMS campaign send pipeline. textCampaignScheduled (create recipients + reserve shortlink + generate coupon) + textCampaignSendTick (5-min cron, sends pending recipients via Twilio).

**File:** `src/lib/inngest/marketing-text.ts`

## Functions

### `marketing-text-campaign-scheduled`
- **Trigger:** event `marketing/text-campaign.scheduled`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


### `marketing-text-campaign-send-tick`
- **Trigger:** cron `* * * * *`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 80 }]`


## Downstream events sent

- `marketing/sms-wave.promote`

## Tables written

- [[../tables/customers]]
- [[../tables/marketing_shortlinks]]
- [[../tables/profile_events]]
- [[../tables/sms_campaign_recipients]]
- [[../tables/sms_campaigns]]
- [[../tables/sms_send_candidates]]

## Tables read (not written)

- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
