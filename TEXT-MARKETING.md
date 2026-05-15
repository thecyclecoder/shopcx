# Text Marketing

Our own SMS marketing system. Replaces Klaviyo SMS sending end-to-end: campaign builder, scheduling, send pipeline, shortlinks, coupons, predictive segmentation, deliverability tracking. Klaviyo is still the historical source (campaign history + engagement events) until our own engagement signals replace it via the storefront pixel + first-party SMS sender.

**Domain:** Settings → Text Marketing · `/dashboard/marketing/text`

## Status (mid-May 2026)

| Capability | State |
|---|---|
| Campaign builder + detail UI | ✅ shipped |
| iPhone-style phone preview | ✅ shipped |
| Twilio send pipeline (Inngest) | ✅ shipped |
| Per-recipient local-time send | ✅ shipped |
| Shortlinks (`superfd.co/XXXXXX`) | ✅ shipped |
| Auto-generated campaign coupons | ✅ shipped |
| Klaviyo SMS history importer | ✅ shipped |
| Klaviyo Placed Order importer + UTM attribution | ✅ shipped |
| Klaviyo engagement backfill (180d, 7 metrics) | ✅ shipped (local script — Inngest version unreliable) |
| Klaviyo engagement incremental sync (daily cron) | ✅ shipped |
| Received SMS event backfill | 🟡 in progress (~100d, ~1-1.4M events) |
| Predicted-buyer segment toggle | ⏳ next |
| `campaign_audience_features` table for runtime segment matching | ⏳ next |
| Klaviyo SMS sending cut over | ✅ done — no campaigns sent through Klaviyo since end of April 2026 |

## Architecture

```
Settings → Text Marketing → Campaign Builder
                                │
                                ▼
                       sms_campaigns (draft)
                                │
                          [Schedule]
                                ▼
                  Inngest: textCampaignScheduled
                                │
            ┌───────────────────┼───────────────────┐
            ▼                                       ▼
  Generate coupon code            Reserve shortlink slugs
  (if coupon_enabled)             (if shortlink_target_url)
            │                                       │
            └───────────────────┬───────────────────┘
                                ▼
                  sms_campaign_recipients
                  (one row per recipient with their
                   resolved local send_time)
                                │
                                ▼
                  Inngest: textCampaignSendTick (5-min cron)
                                │
                                ▼
                  Twilio send → recipients.sent_at
                                │
                                ▼
                  Shortlink clicks: marketing_shortlink_clicks
```

## Data model

### Our own tables

| Table | Purpose |
|---|---|
| `sms_campaigns` | Campaign row — name, message body, MMS image, send_date, target_local_hour, fallback_timezone, audience filter, coupon config, shortlink target |
| `sms_campaign_recipients` | One per recipient: customer_id, phone, resolved local send_time, status (pending/sent/skipped/failed) |
| `marketing_shortlinks` | Slug + target_url + click counters per campaign. Crockford base32 6-char slug. |
| `marketing_shortlink_clicks` | One row per click — timestamp, IP-derived geo, user agent |
| `workspaces.shortlink_domain` | Per-workspace shortlink host (e.g. `superfd.co`) |
| `workspaces.twilio_phone_number` | Per-workspace SMS sender number |

### Klaviyo-imported tables

| Table | Purpose |
|---|---|
| `klaviyo_sms_campaign_history` | Historical Klaviyo SMS campaigns: campaign_id, name, send_time, audience segments, message body, native Klaviyo conversion stats, our recomputed `initial_*` columns |
| `klaviyo_events` | Placed Order events (and others) with `attributed_klaviyo_campaign_id` + `attributed_utm_campaign` — populated by the import job from UTMs |
| `klaviyo_profile_events` | Engagement events: Clicked SMS, Opened Email, Clicked Email, Active on Site, Viewed Product, Added to Cart, Checkout Started — **plus Received SMS once the May 15 backfill finishes** |
| `profile_engagement_summary` | Per-(workspace, profile) rollup of engagement counts in 30/60/90d windows. Built by RPC `rebuild_engagement_summary`. **Currently empty — RPC timed out at 2M+ rows; needs rework.** |
| `workspaces.klaviyo_engagement_backfill_completed_at` | Set when initial 180d backfill finishes. The incremental sync cron only runs against workspaces with this set. |

## Campaign send pipeline

Lives in `src/lib/inngest/marketing-text.ts`. Two functions:

- **`textCampaignScheduled`** — triggered when a campaign is scheduled. Creates `sms_campaign_recipients` rows (one per audience match, with each recipient's `send_time` resolved to their local timezone), generates the coupon code in Shopify if configured, reserves the shortlink slug.
- **`textCampaignSendTick`** — 5-min cron. Selects recipients with `send_time <= now() AND status='pending'`, sends via Twilio, updates `sent_at`. Splits over multiple ticks if the audience is large.

**Why per-recipient local time:** Each recipient gets the SMS at their local `target_local_hour` on `send_date` — not at one global send time. Timezone resolution chain (per `src/lib/timezone-resolver.ts`):

1. Customer's explicit `timezone` column
2. Shipping address zip → tz lookup
3. Phone area code → tz lookup
4. Workspace `fallback_timezone` (default Central)

Recipients in the `fallback` bucket are an audit signal — they all send at the fallback's local hour, which dilutes the "right time" goal. Surfaced on the campaign detail page so you can see when the workspace fallback is doing too much work.

## Shortlinks

- **Domain:** workspace-scoped via `workspaces.shortlink_domain` (e.g. `superfd.co`). Subdomain routing via middleware (`src/lib/supabase/middleware.ts`).
- **Slug:** 6-char Crockford base32, ~1B namespace.
- **Redirect handler:** `src/app/api/sl/[slug]/route.ts` — 302 to `target_url`, logs the click.
- **In message body:** placeholder `{shortlink}` gets substituted with the full URL at send time.
- **CNAME setup:** customer adds CNAME → Vercel; our domain settings page auto-adds the domain to the Vercel project.

## Coupons

- **One coupon per campaign** — created in Shopify at schedule time via the storefront-api admin.
- **Format:** `MAY` + 4 base32 chars (e.g. `MAYBL47`). Predictable enough to read in a phone preview, random enough to not collide.
- **Auto-disable:** the `marketing-coupon-cron` Inngest function disables the Shopify discount `coupon_expires_days_after_send` days after the campaign's first send.
- **In message body:** placeholder `{coupon}` gets substituted with the code.

## Predictive segmentation

The point: out of 138K SMS subscribers, only ~50-200 convert per campaign. Blasting everyone is a 0.1% conversion rate and ~$15-25K per campaign in Twilio costs. Predicting WHO will convert lets us either (a) target the audience to high-probability buyers — same conversions at 5-10× efficiency — or (b) send to a broader audience that includes high-probability buyers we WERE missing.

### Framework (2026-05-14 analysis run, refined 2026-05-15)

**5 buyer archetypes** (% of all converters across 17 campaigns, Feb 15 → May 15):

| Archetype | % | Definition |
|---|---|---|
| **lapsed** | 33.7% | ≥2 prior orders, replenishment ratio > 1.5 |
| **cycle_hitter** | 27.9% | ≥2 prior orders, replenishment ratio 0.5–1.5 (at natural reorder cycle) |
| just_ordered | 13.9% | ≥2 prior orders, replenishment ratio < 0.5 (whale buying again very recently) |
| engaged | 9.1% | ≥1 prior order + high SMS/email engagement |
| cold | 7.7% | 0 prior orders |
| single_order | 7.2% | exactly 1 prior order |
| lurker | 0.5% | 0 orders + high engagement (Bobbi Westfall pattern — exists but rare) |

**Replenishment ratio** = `days_since_last_order / mean_reorder_gap_days`. The strongest single signal.

**Order count is dominant:** 92% of converters have ≥1 prior order; 85% have ≥2. The audience is 69% zero-order profiles (the "spam tax") — filtering those skips 77% of audience while losing only 8% of conversions.

### Per-(profile, campaign) feature set

| Feature | Source |
|---|---|
| `pre_send_orders` | `orders` table, created_at < send_time |
| `pre_send_ltv_cents` | sum total_cents of pre-send orders |
| `days_since_last_order` | send_time - MAX(prior order created_at) |
| `mean_reorder_gap_days` | avg gap between consecutive prior orders |
| `replenishment_ratio` | days_since_last_order / mean_reorder_gap_days |
| `active_sub_at_send` | bool — was there an active subscription at send_time |
| `clicked_sms_60d` | count of Clicked SMS events in 60d before send |
| `opened_email_60d` | Opened Email |
| `clicked_email_60d` | Clicked Email |
| `viewed_product_30d` | Viewed Product (storefront pixel) |
| `added_to_cart_30d` | Added to Cart |
| `checkout_started_30d` | Checkout Started |
| `active_on_site_90d` | Active on Site |

### Holiday vs random campaigns

Campaign-type classification by name pattern:
- `holiday`: VDAY, President's Day, St Patrick's, Easter, Mother's/Father's, Memorial/Labor, BFCM, Christmas
- `vip`: VIP, Diamond, Loyalty, Insider, Members
- `random`: Flash Sale, Spring Sale, Founder's Day, other promo

Engaged archetype over-indexes 13% → 8% on holiday vs random — engaged customers anticipate seasonal sales.

### Recommended V1 segment

The single highest-value filter:
- **`pre_send_orders >= 1`** — captures 92% of conversions, audience drops from 138K to ~43K, ~3× efficiency
- Or **`pre_send_orders >= 2`** — captures 85% at ~5× efficiency

Engagement features aren't strong enough to layer in for V1. Replenishment ratio is a real signal but excluding the 3.0+ deep-lapsed bucket loses 25% of converters — so we don't gate on it for V1 either.

### Case-control analysis (next phase)

Needs `Received SMS` events (recipient list per campaign) to compute true per-campaign lift AND missed-opportunity:

> "How many cycle_hitters did we send Flash Sale 3-25 to, and what was their conversion rate? How many cycle_hitters were SMS-subscribed at send time but NOT in the audience? That's the missed opportunity."

Backfill of `Received SMS` is running as of 2026-05-15 — script `scripts/backfill-received-sms.ts`, metric_id `Vu4Mrq`. Once it lands, re-run `scripts/segment-analysis-3mo.ts` with the recipient-set filter.

## Klaviyo data pipeline

While we cut Klaviyo SMS sending, we still pull from Klaviyo until our storefront pixel replaces Viewed Product / Added to Cart / Checkout Started / Active on Site.

| Function | Trigger | Purpose |
|---|---|---|
| `klaviyoSmsImport` | Event `marketing/klaviyo-sms.import` | One-time / on-demand pull of historical SMS campaigns into `klaviyo_sms_campaign_history` |
| `klaviyoEventsImport` | Event `marketing/klaviyo-events.import` | Pulls Placed Order events with UTM attribution. Throttled. |
| `klaviyoAttributionCompute` | Event `marketing/klaviyo-attribution.compute` | Recomputes `initial_revenue_cents` on campaign history rows by joining Placed Orders via `attributed_klaviyo_campaign_id` |
| `klaviyoEngagementBackfill` | Event `marketing/klaviyo-engagement.backfill` | 180d historical engagement events. **Unreliable on Vercel — use `scripts/backfill-engagement-local.ts` instead.** |
| `klaviyoEngagementSync` | **Cron `0 10 * * *`** + event `marketing/klaviyo-engagement.sync` | Daily incremental delta. Hard 1-day lookback cap (no multi-day catch-up). Hardcoded metric_ids, no `/api/metrics` resolution. |

### Klaviyo UTM attribution

Klaviyo's default UTM template stuffs both the campaign name AND the campaign_id into `utm_campaign`:
```
utm_campaign = "Founder's Day Sale 2 (01KPJZ5Q3QP3Q7R7VM2275XTB5)"
```

The `klaviyo-events-import` job parses the parenthesized ID and writes it to `attributed_klaviyo_campaign_id` on each Placed Order row. That's the precise join key.

## Key files

| File | Purpose |
|---|---|
| `src/app/dashboard/marketing/text/page.tsx` | Campaign list view |
| `src/app/dashboard/marketing/text/new/page.tsx` | Campaign builder + live phone preview |
| `src/app/dashboard/marketing/text/[id]/page.tsx` | Campaign detail — stats, recipient breakdown, tz audit |
| `src/components/sms-phone-preview.tsx` | iPhone-style preview component used in both builder + detail pages |
| `src/lib/inngest/marketing-text.ts` | Schedule + send-tick Inngest functions |
| `src/lib/inngest/marketing-coupon-cron.ts` | Auto-disable expired coupons |
| `src/lib/timezone-resolver.ts` | Per-recipient local time resolution |
| `src/lib/inngest/klaviyo-sms-import.ts` | Historical Klaviyo SMS campaigns import |
| `src/lib/inngest/klaviyo-events-import.ts` | Placed Order events import with UTM attribution |
| `src/lib/inngest/klaviyo-attribution-compute.ts` | Recompute Initial Revenue per campaign |
| `src/lib/inngest/klaviyo-engagement-backfill.ts` | One-shot 180d backfill (Inngest — flaky) |
| `src/lib/inngest/klaviyo-engagement-sync.ts` | Daily incremental cron (hardcoded metric_ids) |
| `scripts/backfill-engagement-local.ts` | The reliable 180d backfill — local Node, resumable |
| `scripts/backfill-received-sms.ts` | Received SMS recipient backfill (run 2026-05-15) |
| `scripts/segment-analysis-3mo.ts` | Predicted-purchase analysis run — 208 converters, archetype + replenishment lift |
| `src/app/api/sl/[slug]/route.ts` | Shortlink redirect handler |
| `APPSTLE-WEBHOOKS.md` | Reference for Appstle webhook payloads (related — subscription state changes feed into pre_send_orders, active_sub_at_send) |

## Cron schedules

| Cron | Schedule | Function |
|---|---|---|
| Engagement incremental sync | `0 10 * * *` (4 AM CST) | `klaviyoEngagementSync` |
| Campaign send tick | `*/5 * * * *` | `textCampaignSendTick` |
| Coupon auto-disable | `0 10 * * *` (also 4 AM CST) | `marketingCouponAutoDisable` |

## Roadmap

| Item | Why |
|---|---|
| **Predicted-buyer segment toggle in builder** | The actual end-state: an admin checkbox "Send to predicted buyers only" that applies the `pre_send_orders >= 1` filter (V1) at schedule time |
| **`campaign_audience_features` table** | Per-(profile, campaign) feature persistence for runtime segment matching. Computing features at scale at send-time is too slow; pre-compute nightly |
| **Fix `rebuild_engagement_summary` RPC timeout** | Current 2M-row GROUP BY times out. Either chunk it, materialized view, or scheduled refresh |
| **Storefront pixel** | Once live, Viewed Product / Added to Cart / Checkout Started flow into `storefront_events` directly instead of via Klaviyo. Per `STOREFRONT.md` |
| **First-party SMS sender** | Already live for new campaigns — replaces Klaviyo SMS entirely. Klaviyo SMS billing already cut |
| **Email cutover** | The remaining Klaviyo dependency. Plan is to ship SMS predicted-buyer segments first, prove the model, then port to email |
