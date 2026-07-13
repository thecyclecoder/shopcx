# creative_skeletons

One row per analyzed competitor/category **winner** pulled from [[../integrations/adlibrary]]. Stores the reverse-engineered **structure** (hook → mechanism claim → proof → offer skeleton) + a **link** to the creative for analysis — never a lifted asset. The cross-brand-repetition signal over these rows is what the Phase 4 pattern matrix mines. See [[../lifecycles/creative-finder]] · [[../specs/winning-static-creative-finder]].

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
| `image_url` | `text` | ✓ | original AdLibrary creative link (analysis only; NOT the display source anymore — see `thumb_path`) |
| `thumb_path` | `text` | ✓ | storage path in the private `creative-shots` bucket of OUR downscaled (2048px q88) analyzable copy — what the dashboard displays via a signed URL. NULL for legacy rows (they fall back to the proxy). Set by [[../libraries/creative-skeleton]] `ingestAd`; migration `20260807120000`. |
| `landing_page_url` | `text` | ✓ | the FULL ad destination WITH path (AdLibrary `landing_page_url`, present on ~half of ads) — e.g. `https://learn.erthlabs.co/women50`, the real advertorial. The [[../libraries/landing-page-scout]] `adDestinationsForBrand` bridge PREFERS this over the bare `destination_domain` (whose root often 404s). Migration `20260807130000`. |
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
| `seed_kind` | `text` | ✓ | `category` \| `competitor` (`category` retired 2026-07-12 — new rows are all `competitor`) |
| `competitor_id` | `uuid` | ✓ | → [[competitors]].id · ON DELETE SET NULL. The approved competitor this ad was scouted for. Stamped by [[../libraries/creative-skeleton]] `ingestAd` from the seed. Migration `20261020120000`. |
| `product_id` | `uuid` | ✓ | → [[products]].id · ON DELETE SET NULL. **The deliberate imitate link** — WHICH of our products this competitor was chosen for. Dahlia's `getProvenCompetitorAngles(productId)` ([[../libraries/creative-sourcing]]) filters on this so a product imitates only its own shelf. Migration `20261020120000`. |
| `status` | `text` | — | default `'analyzed'` · `pending` \| `analyzed` \| `video_pending` \| `shortlisted` \| `archived` \| `failed` |
| `raw` | `jsonb` | ✓ | full AdLibrary row for replay/audit |
| `visioned_at` | `timestamptz` | ✓ | when the skeleton was extracted |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, source, dedup_key)` — the idempotent upsert key.
**Indexes:** `(workspace_id, status)`, `(workspace_id, advertiser)`, `(workspace_id, days_running desc)`, `(workspace_id, destination_domain) WHERE destination_domain IS NOT NULL` ([[../specs/landing-page-scout]] read path), `(product_id)`, `(competitor_id)` (per-product scout read path, migration `20261020120000`).

> **Deliberate-scout reset (2026-07-12).** Migration `20261020120000` added `product_id` + `competitor_id` and **hard-cleared all 473 pre-refactor rows** (`delete where product_id is null`) — they predated product tagging and weren't re-derivable. HARD delete (not archive) because the pattern-matrix / promotion scans read `source='adlibrary'` with no status filter. The [[../inngest/creative-scout]] repopulates per-product, tagged. This is the "clean the competitive ad library" step of the base-layer imitate→innovate fix.

## RLS

- `creative_skeletons_select` — `authenticated` read where `workspace_id` ∈ caller's `workspace_members`.
- `creative_skeletons_service` — `service_role` full. All writes go through `createAdminClient()`.

## Gotchas

- **Statics are visioned at ingestion** (`status='analyzed'`); **videos are routed aside** (`status='video_pending'`) and then drained by the **video pipeline** ([[../libraries/video-skeleton]] · [[../specs/creative-finder-video]]) — `creative-finder-video-process` downloads → ffmpeg keyframes + Whisper transcript → the same four-slot skeleton and flips the row to `analyzed` (or `failed`). The status flip is the dedup: a video `ad_key` is processed once.
- The matrix counts **distinct `advertiser`s** — repetition across independent brands is the signal, never one ad's `heat`/`days_running` (those are tiebreakers only).
- **Display serves OUR hosted copy, not AdLibrary.** `image_url` 403s without the Bearer key AND is full-res (6–22MB) — live-proxying it 502'd (serverless response-size limit). So `ingestAd` stores a downscaled analyzable copy in the private `creative-shots` bucket (`thumb_path`) and the list route returns a signed URL to it. `/api/ads/creative-finder/media` remains only as a downscaling fallback for legacy rows without `thumb_path`.
- **Full payload from `ingestAd`, not vision** — `destination_domain`/copy/CTA/spend/engagement/`platform` columns come straight from the AdLibrary row ([[../specs/ad-creative-scout]]); only `format`/`framework`/`hook`/`mechanism_claim`/`proof`/`offer` are vision-extracted. `destination_domain` is null for ads with no store url (`has_store_url=false`).

## Written by
[[../libraries/creative-skeleton]] (`ingestAd`) ← [[../inngest/creative-finder]]; [[../libraries/video-skeleton]] (`processVideoPending` updates `video_pending` → `analyzed`) ← [[../inngest/creative-finder]] (`creative-finder-video-process`).

## Read by
[[../libraries/creative-skeleton]] (`buildPatternMatrix`, dedup) · [[../libraries/ad-gap]] (`buildAdGapReport` — angle gaps) · [[../libraries/competitors]] (`promoteFromCategorySweep`) · `/api/ads/creative-finder*` routes · [[../specs/landing-page-scout]] (`destination_domain` per approved competitor).

## Related
[[../specs/winning-static-creative-finder]] · [[../specs/ad-creative-scout]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[../libraries/ad-gap]] · [[../inngest/creative-finder]] · [[../functions/growth]]
