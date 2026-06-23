# creative_skeletons

One row per analyzed competitor/category **winner** pulled from [[../integrations/adlibrary]]. Stores the reverse-engineered **structure** (hook → mechanism claim → proof → offer skeleton) + a **link** to the creative for analysis — never a lifted asset. The cross-brand-repetition signal over these rows is what the Phase 4 pattern matrix mines. See [[../specs/winning-static-creative-finder]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `source` | `text` | — | default `'adlibrary'` |
| `dedup_key` | `text` | — | AdLibrary `ad_key` — idempotency key; never re-vision/re-spend |
| `advertiser` | `text` | ✓ | the **brand** — the unit of "independent" for the matrix |
| `title` | `text` | ✓ | AdLibrary `title` (often thin) |
| `image_url` | `text` | ✓ | original AdLibrary creative link (analysis only; displayed via the authenticated proxy) |
| `media_type` | `text` | — | default `'static'` · `static` \| `video` (routed at ingestion) |
| `format` | `text` | ✓ | `ugc` \| `studio` \| `text-card` \| `before_after` \| `demo` \| … (vision) |
| `framework` | `text` | ✓ | `hook-promise-proof` \| `problem-pivot-payoff` \| variant (vision) |
| `hook` | `text` | ✓ | slot 1 (vision) |
| `mechanism_claim` | `text` | ✓ | slot 2 (vision) |
| `proof` | `text` | ✓ | slot 3 (vision) |
| `offer` | `text` | ✓ | slot 4 (vision) |
| `days_running` | `int4` | ✓ | AdLibrary `days_count` — longevity = winner proxy |
| `heat` | `numeric` | ✓ | AdLibrary `heat` / exposure score |
| `first_seen` | `date` | ✓ | AdLibrary `first_seen` |
| `last_seen` | `date` | ✓ | AdLibrary `last_seen` |
| `resume_advertising` | `bool` | ✓ | AdLibrary `resume_advertising_flag` — "still running" |
| `destination_domain` | `text` | ✓ | AdLibrary `ecom_advertiser_id` — the **store domain this ad drives to** (e.g. `shop.ryzesuperfoods.com`). The bridge to [[../specs/landing-page-scout]] |
| `has_store_url` | `bool` | ✓ | AdLibrary `has_store_url` |
| `call_to_action` | `text` | ✓ | AdLibrary `call_to_action` ("Shop Now" / "Learn More") |
| `body` | `text` | ✓ | AdLibrary `body` — full ad copy (thin, but captured) |
| `message` | `text` | ✓ | AdLibrary `message` — secondary copy line |
| `estimated_spend` | `numeric` | ✓ | AdLibrary `estimated_spend` — spend/offer-pressure signal |
| `all_exposure_value` | `numeric` | ✓ | AdLibrary `all_exposure_value` |
| `impression` | `numeric` | ✓ | AdLibrary `impression` |
| `like_count` | `int4` | ✓ | AdLibrary `like` |
| `comment_count` | `int4` | ✓ | AdLibrary `comment` |
| `share_count` | `int4` | ✓ | AdLibrary `share` |
| `view_count` | `int8` | ✓ | AdLibrary `view` |
| `platform` | `text` | ✓ | AdLibrary `platform` (facebook/instagram/…) |
| `fb_merge_channel` | `text` | ✓ | AdLibrary `fb_merge_channel` |
| `ads_type` | `int4` | ✓ | AdLibrary `ads_type` (1=image, 2=video) |
| `seed_keyword` | `text` | ✓ | the query that surfaced it |
| `seed_kind` | `text` | ✓ | `category` \| `competitor` |
| `status` | `text` | — | default `'analyzed'` · `pending` \| `analyzed` \| `video_pending` \| `shortlisted` \| `archived` \| `failed` |
| `raw` | `jsonb` | ✓ | full AdLibrary row for replay/audit |
| `visioned_at` | `timestamptz` | ✓ | when the skeleton was extracted |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, source, dedup_key)` — the idempotent upsert key.
**Indexes:** `(workspace_id, status)`, `(workspace_id, advertiser)`, `(workspace_id, days_running desc)`, `(workspace_id, destination_domain) WHERE destination_domain IS NOT NULL` ([[../specs/landing-page-scout]] read path).

## RLS

- `creative_skeletons_select` — `authenticated` read where `workspace_id` ∈ caller's `workspace_members`.
- `creative_skeletons_service` — `service_role` full. All writes go through `createAdminClient()`.

## Gotchas

- **Statics are visioned at ingestion** (`status='analyzed'`); **videos are routed aside** (`status='video_pending'`) for the heavier Phase 6 frame+transcript pipeline (not yet built).
- The matrix counts **distinct `advertiser`s** — repetition across independent brands is the signal, never one ad's `heat`/`days_running` (those are tiebreakers only).
- `image_url` 403s without the AdLibrary Bearer key — display goes through `/api/ads/creative-finder/media`.
- **Full payload from `ingestAd`, not vision** — `destination_domain`/copy/CTA/spend/engagement/`platform` columns come straight from the AdLibrary row ([[../specs/ad-creative-scout]]); only `format`/`framework`/`hook`/`mechanism_claim`/`proof`/`offer` are vision-extracted. `destination_domain` is null for ads with no store url (`has_store_url=false`).

## Written by
[[../libraries/creative-skeleton]] (`ingestAd`) ← [[../inngest/creative-finder]].

## Read by
[[../libraries/creative-skeleton]] (`buildPatternMatrix`, dedup) · [[../libraries/ad-gap]] (`buildAdGapReport` — angle gaps) · [[../libraries/competitors]] (`promoteFromCategorySweep`) · `/api/ads/creative-finder*` routes · [[../specs/landing-page-scout]] (`destination_domain` per approved competitor).

## Related
[[../specs/winning-static-creative-finder]] · [[../specs/ad-creative-scout]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[../libraries/ad-gap]] · [[../inngest/creative-finder]] · [[../functions/growth]]
