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

## Gotchas

- **System User token required for CAPI** in production. Don't use admin user tokens — they expire 60d after consent.
- **`event_id` dedup is per-pixel.** If you fan out the same `event_id` to two pixels, both will dedup against their own browser-side events. Good.
- **Hashed PII must be lowercased + trimmed** before SHA-256. Meta will silently drop events with raw PII — no error, just no attribution.
- **`_fbp` + `_fbc` cookies** boost match rate. Capture them in [[../tables/storefront_sessions]] and forward on every CAPI dispatch.
- **Ad account ids are prefixed `act_`** (`act_1234567890`). The bare numeric id is not a valid path segment.
- **`adcreatives` per-account list can be huge** (10k+). Paginate via `paging.next`, don't bulk-fetch.

## Files

- `src/lib/inngest/sinks/meta-capi.ts` — CAPI dispatcher (server-side event sink)
- `src/lib/meta.ts` — Token + permission helpers shared with [[meta-graph]]
- Ads spend rollup: `src/lib/inngest/...` (in flight — see [[../tables/sms_campaigns]] ROAS roadmap)

## Related

[[../tables/meta_ad_accounts]] · [[../tables/daily_meta_ad_spend]] · [[../tables/meta_post_cache]] · [[../tables/event_sinks]] · [[../tables/event_dispatches]] · [[../tables/storefront_events]] · [[../tables/storefront_sessions]] · [[meta-graph]]
