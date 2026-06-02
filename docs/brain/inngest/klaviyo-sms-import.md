# inngest/klaviyo-sms-import

On-demand pull of historical Klaviyo SMS campaigns → `klaviyo_sms_campaign_history`.

**File:** `src/lib/inngest/klaviyo-sms-import.ts`

## Functions

### `klaviyo-sms-import`
- **Trigger:** event `marketing/klaviyo-sms.import`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 2 }]`


## Downstream events sent

- `marketing/klaviyo-attribution.compute`
- `marketing/klaviyo-events.import`

## Tables written

- [[../tables/klaviyo_sms_campaign_history]]

## Tables read (not written)

- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
