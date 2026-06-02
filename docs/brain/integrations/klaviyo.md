# klaviyo

Klaviyo API. Per-workspace API key. Source of truth for: historical SMS campaigns, Placed Order events, engagement events (Clicked/Opened/Active on Site), product reviews. Sunset path is the storefront pixel + our own SMS sender; until then Klaviyo is the data backbone.

## Auth

- **Encrypted on `workspaces`:** `klaviyo_api_key_encrypted` (server-side private key)
- **Plain:** `klaviyo_public_key` (used by the customer-facing forms / web tracker)

Loaded by helpers in `src/lib/klaviyo.ts`. Headers: `Authorization: Klaviyo-API-Key {key}` + `revision: 2024-10-15` (or the version pinned in code).

## Key endpoints we call

Base: `https://a.klaviyo.com/api`

| Endpoint | Method | Purpose |
|---|---|---|
| `/profiles/` | GET | Profile directory enrichment |
| `/profiles/{id}/` | GET | Single profile (phone/email/timezone) |
| `/events/` | GET | Pull Placed Order + engagement events (filtered by metric_id) |
| `/metrics/` | GET | Resolve metric_id ↔ name (cached) |
| `/campaigns/` | GET | Historical SMS campaign list |
| `/campaign-messages/` | GET | Per-message body + audience |
| `/reviews/` | GET | Product reviews sync |

Hardcoded metric_ids (no `/metrics/` resolution in the sync cron): `Received SMS`, `Clicked SMS`, `Opened Email`, `Clicked Email`, `Active on Site`, `Viewed Product`, `Added to Cart`, `Checkout Started`. See `src/lib/inngest/klaviyo-engagement-sync.ts`.

## Rate limits + retry

- Klaviyo rate-limits at `/api/profiles/` and `/api/events/` with `429` + `Retry-After` header.
- `klaviyo.ts` helpers respect `Retry-After`; cron jobs throttle to avoid bursts.
- Engagement backfill via Inngest is **unreliable on Vercel** (function timeouts under load). Use `scripts/backfill-engagement-local.ts` instead — resumable, ~140/sec. See [[../inngest/klaviyo-engagement-backfill]].

## UTM attribution parsing

Klaviyo's default UTM template stuffs the campaign id into `utm_campaign` parenthesized:
```
utm_campaign = "Founder's Day Sale 2 (01KPJZ5Q3QP3Q7R7VM2275XTB5)"
```
The events-import job parses the parenthesized id into [[../tables/klaviyo_events]].`attributed_klaviyo_campaign_id`. Drives [[../inngest/klaviyo-attribution-compute]] recomputes of `initial_revenue_cents`.

## Reviews

`syncReviews()` pulls product reviews → [[../tables/product_reviews]]. AI-summarized (Haiku, max 15 words) for cancel-journey social proof. Featured reviews (Klaviyo `smart_featured`) prioritized, then highest-rated.

## Gotchas

- **API revision is in the header**, not the path. Pin a version per call (`revision: 2024-10-15` style). Klaviyo deprecates aggressively.
- **profile.id ≠ profile.email**. Email match is fuzzy (Klaviyo lowercases + trims). Match-or-create flow lives in `src/lib/inngest/klaviyo-profile-staging.ts`.
- **Engagement summary RPC `rebuild_engagement_summary` times out** at 2M+ rows — `profile_engagement_summary` is currently empty. Predicted-buyer segments compute on-the-fly until the RPC is reworked. See TEXT-MARKETING.md.
- **No webhook surface for events.** Everything is pull-based — daily cron + on-demand triggers.
- **Klaviyo SMS sending is OFF**. All SMS campaigns since end of April 2026 ship through our pipeline ([[../inngest/marketing-text]]). Don't accidentally re-enable Klaviyo SMS.

## Files

- `src/lib/klaviyo.ts` — API client (reviews, profiles, events)
- `src/lib/inngest/klaviyo-events-import.ts` — Placed Order import + UTM attribution
- `src/lib/inngest/klaviyo-attribution-compute.ts` — Recompute campaign `initial_revenue_cents`
- `src/lib/inngest/klaviyo-engagement-sync.ts` — Daily 4am CST cron
- `src/lib/inngest/klaviyo-engagement-backfill.ts` — One-shot 180d (flaky)
- `src/lib/inngest/klaviyo-sms-import.ts` — Historical SMS campaigns
- `src/lib/inngest/sync-reviews.ts` — Reviews sync
- `scripts/backfill-engagement-local.ts` — Reliable local backfill

## Related

[[../tables/klaviyo_events]] · [[../tables/klaviyo_profile_directory]] · [[../tables/klaviyo_profile_staging]] · [[../tables/klaviyo_sms_campaign_history]] · [[../tables/profile_events]] · [[../tables/profile_engagement_summary]] · [[../tables/product_reviews]]
