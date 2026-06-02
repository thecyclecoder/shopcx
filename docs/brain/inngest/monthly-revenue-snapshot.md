# inngest/monthly-revenue-snapshot

Month-end rollup → `monthly_revenue_snapshots`.

**File:** `src/lib/inngest/monthly-revenue-snapshot.ts`

## Functions

### `monthly-revenue-snapshot`
- **Trigger:** event `revenue/rebuild-snapshots`
- **Retries:** 1


## Downstream events sent

_None._

## Tables written

- [[../tables/monthly_revenue_snapshots]]

## Tables read (not written)

- [[../tables/daily_amazon_order_snapshots]]
- [[../tables/daily_meta_ad_spend]]
- [[../tables/daily_order_snapshots]]
- [[../tables/workspaces]]

## Header notes

```
Nightly cron: pre-compute monthly revenue snapshots from daily data
Runs at 2 AM Central (7 AM UTC), rebuilds all months
```

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
