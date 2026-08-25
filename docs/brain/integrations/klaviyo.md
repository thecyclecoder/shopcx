# klaviyo

⚠️ **RETIRED VENDOR — the subscription was cancelled (August 2026). No code path may call this API.**

Klaviyo was the data backbone for historical SMS campaigns, Placed Order events, engagement events, and product reviews. It is being sunset in two phases. **Phase A (shipped) stopped every outbound call.** Phase B deletes the machinery and the dead tables.

Enforced by [[../libraries/klaviyo-retired]] (`KLAVIYO_RETIRED`, always `true`) and by `scripts/_check-no-klaviyo-calls.ts`, which fails `predeploy` if any `src/**` file names `a.klaviyo.com` without importing the guard. **Turning any of this back on needs a contract first.**

## What Phase A stopped

| Surface | Was | Now |
|---|---|---|
| `/dashboard/reviews` moderation | PATCHed Klaviyo `/reviews/{id}/` for every row with a `klaviyo_review_id` — i.e. all ~10.7k | Local-only. `product_reviews` is the sole system of record; rejection reason + explanation persist on the row. See [[../dashboard/reviews]] |
| `/api/lead` | Fire-and-forget profile upsert + consent push on every storefront lead | **Removed.** No customer PII leaves for the vendor. Meta CAPI Lead is unaffected (it flows via the `lead_captured` storefront event) |
| `sync-klaviyo-reviews` (cron, 3am) | Pulled `/reviews/` nightly | Guarded no-op that still beats, so Control Tower reads *retired* rather than RED *no beats* |
| `klaviyo-engagement-sync` (cron, 10:00 UTC) | Pulled 8 metrics into [[../tables/profile_events]] | Same — guarded no-op + heartbeat |
| `klaviyo-events-import` · `klaviyo-sms-import` · `klaviyo-engagement-backfill` · `klaviyo-attribution-compute` | Event-triggered imports | Guarded no-ops returning `KLAVIYO_RETIRED_RESULT` |
| `/api/workspaces/[id]/sync-reviews` | Fired a full re-sync | `410 Gone`. The dashboard's Sync button is gone |

## What survives the sunset

- **[[../tables/product_reviews]] — 10,745 rows.** The table is NOT going anywhere: it feeds storefront PDPs, the ad tool's tier-4 proof anchors, [[../lifecycles/product-intelligence]], cancel-journey social proof, review cards, and storefront email. `klaviyo_review_id` stays as provenance.
- **The table-only helpers in [[../libraries/klaviyo]]** — `getReviewsForProducts`, `polishReviewBodies`, `generateMissingSummaries`. They read `product_reviews` (+ Anthropic) and never touched the vendor.
- **[[../tables/profile_events]] — 4.66M rows.** Dual-sourced: our own SMS pipeline writes `Received SMS` / `Clicked SMS` there via [[../inngest/marketing-text]] and the shortlink route. Only the Klaviyo-sourced half stops.

## Known gaps left by the sunset

- **Review collection is dark.** The Klaviyo review-request flow was the ONLY thing that ever created a `product_reviews` row — the sync upsert is the sole INSERT in the codebase. The last review landed **2026-07-01**. Nothing collects reviews until the in-house program ships.
- **Review photos.** 95 reviews carry Klaviyo-relative image paths (`{company_id}/{uuid}.jpg?updated_at=…`). Nothing renders them today, but the assets live on Klaviyo's CDN and die with the account. `scripts/_backfill-review-images-to-storage.ts` mirrors them into `product-media` — it needs the CDN base read off the Klaviyo dashboard (see the script header).
- **Email marketing.** `Opened Email` / `Clicked Email` events were still arriving at sunset, i.e. Klaviyo flows were still sending. There is no in-house replacement for marketing email — only transactional ([[../lifecycles/order-confirmation]]) and cart recovery. Owned by [[../functions/cmo]].
- **Engagement segments.** `profile_engagement_summary` was already empty (its rebuild RPC times out at 2M+ rows). The Klaviyo engagement half of `profile_events` now freezes; the `scripts/segment-analysis-*.ts` one-offs that read it will only see our own SMS events going forward.

## Phase B (not yet done)

Delete the five Inngest functions + their `MONITORED_LOOPS` rows + kill switches, the manual trigger routes, [[../libraries/klaviyo-lead]], the Klaviyo card in integrations settings, and the dead `klaviyo_*` tables (`klaviyo_events` 19.7k frozen · `klaviyo_profile_directory` 424 · `klaviyo_sms_campaign_history` 0 · `klaviyo_profile_staging` 0 · `profile_engagement_summary` 0). `db-health.ts` and `migration-drift.ts` already whitelist `klaviyo_*` as retiring. Null the `klaviyo_api_key_encrypted` + `klaviyo_public_key` columns. Remove Klaviyo's onsite JS from the Shopify storefront theme — it is still firing `Viewed Product` / `Added to Cart` / `Active on Site`.

## Historical reference

Auth was `klaviyo_api_key_encrypted` (server key) + `klaviyo_public_key` (public company id, `JBF4n4`), header `Authorization: Klaviyo-API-Key {key}` + `revision: 2024-10-15`. Endpoints we called: `/profiles/`, `/events/`, `/metrics/`, `/campaigns/`, `/campaign-messages/`, `/reviews/`. Klaviyo's UTM template stuffed the campaign id into `utm_campaign` parenthesized — `"Founder's Day Sale 2 (01KPJZ…)"` — which the events importer parsed into `attributed_klaviyo_campaign_id`.

## Related

[[../libraries/klaviyo-retired]] · [[../libraries/klaviyo]] · [[../tables/product_reviews]] · [[../tables/profile_events]] · [[../tables/klaviyo_events]] · [[../dashboard/reviews]] · [[../functions/cmo]]
