# meta-marketing

Meta Marketing API — paid ads (campaigns, ad sets, creatives, spend). Used by ROAS dashboards + storefront-events CAPI fan-out. (For organic page/comment/DM management see [[meta-graph]].)

## Auth

Shares the same OAuth tokens as [[meta-graph]] — the user-level access token has both `pages_*` (organic) and `ads_*` (ads) scopes when the user is admin on both the page and the ad account.

- **Tokens (encrypted on `workspaces`):** `meta_user_access_token_encrypted` (admin-level — required for ad-account reads), `meta_page_access_token_encrypted` (insufficient by itself for `/{ad-account}/insights` calls).
- **Ad account discovery:** stored in [[../tables/meta_ad_accounts]] (one row per connected `act_{id}`).

Required scopes: `ads_read`, `ads_management`, `business_management`. Plus the organic scopes from [[meta-graph]] OAuth.

## API version

Same as [[meta-graph]]. Base: `https://graph.facebook.com/{version}`.

## Key endpoints we call

| Endpoint | Method | Purpose |
|---|---|---|
| `/me/adaccounts` | GET | List ad accounts user has access to |
| `/{ad-account-id}` | GET | Account metadata |
| `/{ad-account-id}/campaigns` | GET | Campaign list |
| `/{ad-account-id}/insights?fields=spend,reach,impressions,actions&date_preset=yesterday&level=account` | GET | Daily spend rollup — drives [[../tables/daily_meta_ad_spend]] |
| `/{ad-account-id}/insights?level=campaign` / `?level=adset` / `?level=ad` | GET | Per-level breakdowns |
| `/{ad-account-id}/adcreatives?fields=effective_object_story_id` | GET | Ad creative → post mapping for comment attribution. Drives [[../tables/meta_post_cache]]. |
| `/{event-id}/...` (Conversions API) | POST | Server-side event fan-out — see CAPI dispatcher |

## Conversions API (CAPI)

Server-side event ingest for ad attribution. Mirrors the browser pixel events but bypasses ad-blockers.

- **Endpoint:** `https://graph.facebook.com/{version}/{pixel-id}/events?access_token={system-user-token}`
- **Payload:** array of events with `event_name`, `event_time`, `event_id` (matches our `storefront_events.id` for dedup), `user_data` (SHA-256 hashed email/phone), `custom_data` (value, currency, content_ids).
- **Dispatcher:** `src/lib/inngest/sinks/meta-capi.ts` — reads pending [[../tables/event_dispatches]] rows, posts, updates status.
- **Why:** dual-track with browser pixel; same `event_id` → Meta dedupes. Browser-only loses 30-40% to ad-blockers; server+browser captures both.

System User token (long-lived, no expiry) preferred over admin user token for CAPI — admin tokens expire. Stored in [[../tables/event_sinks]].`config` (encrypted).

## Rate limits + retry

- Marketing API uses **Business Use Case** rate limits, exposed via `X-Business-Use-Case-Usage` header per ad account. Format: `{ act_id: { call_count, total_cputime, estimated_time_to_regain_access }}`.
- Throttling kicks in around 80% of any budget. Back off aggressively when `estimated_time_to_regain_access > 0`.
- CAPI has separate per-pixel limits. 429 → exponential backoff via Inngest retries.
- **Permanent / api-removed** — a class distinct from transient (retry-able) and fatal (caller-fixable): Meta has REMOVED the endpoint we depended on and it will not come back. Retrying only burns quota. Classified by [[../libraries/meta__graph-retry]] `isPermanentGraphError` on code `100` subcode `2490568` (the seed signature — "ASC campaigns no longer supported") plus messages matching `/no longer supported|deprecated|not supported with v\d+/i` on HTTP 400. `graphFetchJson` short-circuits the retry loop and tags the throw with `metaClass='permanent_api_removed'`; the CEO card is raised through [[../libraries/meta__dead-verb-escalation]] `escalateDeadMetaVerb` (deduped per capability signature per UTC day). Introduced by **[[../specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]] Phase 2** — the CEO discovered the ASC removal on 2026-07-27 when the cold-scaler mint failed in his face; there had been no signal that a whole autonomous capability had gone silent.
- **App-owner-action-required** — a class distinct from permanent and transient: Meta has imposed a gate (canonical example: the yearly "Data Use Checkup") that a HUMAN must clear from the Meta App Dashboard before the API will return data again. Classified by [[../libraries/meta__graph-retry]] `classifyAppOwnerActionRequired` on HTTP 400 when the message contains Meta's canonical phrasings ("data use checkup", "api access disrupted", "app is currently unavailable"). `graphFetchJson` short-circuits the retry loop and tags the throw with `metaClass='app_owner_action_required'`; the CEO card is raised through [[../libraries/meta__app-owner-action-escalation]] `escalateAppOwnerActionRequired` (deduped per workspace per UTC day, so a persistent gate surfaces once per day, not once per retry). Introduced by **[[../specs/meta-graph-classify-app-owner-action-required-data-use-check]] Phase 1** — the 5-min today-sync cron was logging this class as `console.error` per active ad account per tick (~576/day), flooding the Control Tower error feed with identical entries that carried no information beyond the first occurrence.

## Gotchas

- **System User token required for CAPI** in production. Don't use admin user tokens — they expire 60d after consent.
- **`event_id` dedup is per-pixel.** If you fan out the same `event_id` to two pixels, both will dedup against their own browser-side events. Good.
- **Hashed PII must be lowercased + trimmed** before SHA-256. Meta will silently drop events with raw PII — no error, just no attribution.
- **`_fbp` + `_fbc` cookies** boost match rate. Capture them in [[../tables/storefront_sessions]] and forward on every CAPI dispatch.
- **Ad account ids are prefixed `act_`** (`act_1234567890`). The bare numeric id is not a valid path segment.
- **`adcreatives` per-account list can be huge** (10k+). Paginate via `paging.next`, don't bulk-fetch.

## Ad publishing (WRITE — 2026-06-10)

No longer read-only: the ad tool **publishes ads to Meta** via `src/lib/meta-ads.ts` (Graph v21.0, form-encoded POSTs, `ads_management` token from `meta_connections`). Flow: `act_{id}/advideos` (upload video by `file_url`) → poll `GET /{video_id}?fields=status` → `act_{id}/adcreatives` (`asset_feed_spec` copy variants + `object_story_spec`) → `act_{id}/ads` (default **PAUSED**). Targets listed via `/me/adaccounts`, `act_{id}/campaigns`, `act_{id}/adsets`, `/me/accounts` (pages). See [[../lifecycles/ad-publish]] + [[../libraries/meta-ads]] + [[../tables/ad_publish_jobs]].

## Campaign + ad-set creation (WRITE — 2026-07-07, media-buyer loop)

The media-buyer loop stands up its own PAUSED test ad set per creative concept (no human hand-building):

| Endpoint | Method | Purpose |
|---|---|---|
| `/act_{id}/campaigns` | POST | Create a PAUSED ABO `OUTCOME_SALES` campaign. Requires `is_adset_budget_sharing_enabled=false` when NO campaign budget is set (2026-07-07). CBO branch sets `daily_budget`/`lifetime_budget` in minor units **and ALWAYS sends an explicit `bid_strategy`** (default `LOWEST_COST_WITHOUT_CAP` — no bid limit). CBO ad sets INHERIT the campaign bid strategy, and an omitted value falls back to the AD ACCOUNT default — on `196487894712827` that is `LOWEST_COST_WITH_BID_CAP`, which then fails the follow-up ad-set create with `(#100/1815857) Bid Amount Required For The Bid Strategy Provided` (2026-07-27). ⚠️ **`smart_promotion_type="AUTOMATED_SHOPPING_ADS"` (Advantage+ Sales / ASC) is DEAD**: Graph **v24.0+** rejects creation with `(#100/2490568) ASC campaigns no longer supported`. `existing_customer_budget_percentage` was an ASC-only companion knob and is no longer sent either — new-customer-only is enforced at the AD SET via `targeting.excluded_custom_audiences`. |
| `/act_{id}/adsets` | POST | Create a PAUSED purchase-optimized ad set: `optimization_goal=OFFSITE_CONVERSIONS`, `billing_event=IMPRESSIONS`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `promoted_object={pixel_id,custom_event_type:"PURCHASE"}`, Advantage+ placements (omit `publisher_platforms`/`*_positions`), ad-set-level `daily_budget`. |

Wired via `createCampaign` + `createAdSet` + `getOrCreateTestingCampaign` + `getOrCreateColdScalerCampaign` in [[../libraries/meta-ads]]. The loop reuses one shared `"MB — Testing (ABO)"` campaign per account (idempotent find-or-create by name), then creates one PAUSED ad set per concept under it — going-live is a separate governed step in `src/lib/meta/recommendation-execute.ts`, never automatic. The Bianca cold-scaler graduate verb mints one PAUSED consolidated **CBO `OUTCOME_SALES`** campaign per cohort at `LOWEST_COST_WITHOUT_CAP` (no bid limit) and stamps its id on `media_buyer_cold_scaler_cohorts.scaler_meta_campaign_id` via `setColdScalerCampaignId` (compare-and-set). It is **no longer an Advantage+ Sales (ASC) campaign** — Meta removed ASC creation in Graph v24.0, which silently blocked every graduate until 2026-07-27.

## Files

- `src/lib/meta-ads.ts` — **ad publishing** (advideos → adcreatives → ads) + listing
- `src/lib/inngest/sinks/meta-capi.ts` — CAPI dispatcher (server-side event sink)
- `src/lib/meta.ts` — Token + permission helpers shared with [[meta-graph]]
- Ads spend rollup: `src/lib/inngest/...` (in flight — see [[../tables/sms_campaigns]] ROAS roadmap)

## Related

[[../tables/meta_ad_accounts]] · [[../tables/daily_meta_ad_spend]] · [[../tables/meta_post_cache]] · [[../tables/event_sinks]] · [[../tables/event_dispatches]] · [[../tables/storefront_events]] · [[../tables/storefront_sessions]] · [[meta-graph]]
