# SMS segment performance (our own sends)

Per-segment conversion for marketing SMS, computed from **our own Twilio sends** — not Klaviyo's historical numbers. This is the canonical source for "which [[tables/customers]].`segments` are worth texting, and what do they actually convert at." The campaign-builder hints in `src/app/dashboard/marketing/text/new/page.tsx` mirror these figures.

## Snapshot — as of 2026-06-14

Across **32 single-segment campaigns** over 5 sale events (2026-05-16 → 2026-05-31): VIP Sale, MDW Early Access, BIG MDW Sale, MDW Final, SUMMERFIT. **32,045 sent · 6,861 clicks (21.4%) · 42 attributed orders · $4,735 revenue.**

| Segment | Sent | Click % | Conv | **CVR** | Rev/send | Klaviyo (old) |
|---|---:|---:|---:|---:|---:|---:|
| `engaged` | 1,727 | 43.4% | 6 | 0.35% | $0.35 | 0.44% |
| `cycle_hitter` | 2,449 | 22.0% | 8 | 0.33% | **$0.41** | 0.30% |
| `lapsed` | 1,441 | 26.6% | 5 | 0.35% | $0.37 | 0.10% |
| `just_ordered` | 1,473 | 26.7% | 2 | 0.14% | $0.21 | 0.19% |
| `deep_lapsed` | 17,850 | 18.1% | 17 | 0.10% | $0.11 | *(none)* |
| `single_order` | 6,178 | 20.5% | 3 | 0.05% | $0.03 | 0.03% |
| `active_sub` | 927 | 32.3% | 1 | 0.11% | $0.17 | — |
| **Total** | **32,045** | 21.4% | **42** | **0.13%** | $0.15 | — |

`cold` (0 orders) and `storefront_signup` (new) have **no in-house send history** yet. The first `storefront_signup` data point comes from the 2026-06-15 Founder's VIP Invite send.

## How to read this

- **By revenue/send (the metric that matters):** `cycle_hitter` ($0.41) and `lapsed` ($0.37) lead, then `engaged` ($0.35). `single_order` ($0.03) is the weakest converter.
- **`lapsed` beats its Klaviyo reputation** (0.35% vs Klaviyo's 0.10%) — don't under-weight it.
- **`deep_lapsed`** is low-rate (0.10%) but its sheer volume makes it the **biggest single revenue contributor** ($1,909) — worth sending despite the rate.
- **Small-sample caveat:** only **42 attributed orders** total. `engaged`/`cycle_hitter`/`lapsed` (~0.33–0.35%, 5–8 orders each) are a **statistical tie**, not a ranking. Only `deep_lapsed` and `single_order` have enough volume to trust the rate. Refresh this page after each sale event.
- **CVR is a floor.** Counts only orders precisely UTM-attributed to the campaign (`orders.attributed_utm_campaign = campaign.id`). A recipient who didn't tap the link but bought (typed the coupon, returned later) isn't counted. True CVR is somewhat higher; the [[inngest/marketing-text]] dashboard also surfaces "untracked coupon redemptions" for coupon-matched orders with no UTM.

## How it's computed (recompute after each send)

Every marketing campaign targets a **single** segment (`sms_campaigns.included_segments` has one entry), so the segment = the campaign. Aggregate per segment over all `status='sent'` campaigns:

- **Sent** = [[tables/sms_campaign_recipients]] rows with `status IN ('sent','delivered')`.
- **Clicks** = sum of [[tables/marketing_shortlinks]].`click_count` for the campaign.
- **Conv / revenue** = [[tables/orders]] where `attributed_utm_campaign = campaign.id`, **excluding** sub-renewal orders (`source_name IN ('subscription_contract','subscription_contract_checkout_one')` OR `subscription_id IS NOT NULL`) — mirrors the dashboard attribution in `/api/workspaces/[id]/sms-campaigns` GET.
- **CVR** = conv / sent.

Per-segment point-in-time membership isn't stored on recipients, but because each campaign is single-segment the campaign's segment is authoritative for all its recipients.

## Related

[[inngest/marketing-text]] · [[inngest/refresh-customer-segments]] (defines the segments) · [[tables/sms_campaigns]] · [[tables/sms_campaign_recipients]] · [[tables/marketing_shortlinks]]
