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
| `hook` | `text` | ✓ | slot 1 (vision) — **substance column, kept for the analyzed-competitor archive** (see the Wireframe redesign gotcha). |
| `mechanism_claim` | `text` | ✓ | slot 2 (vision) — substance column. |
| `proof` | `text` | ✓ | slot 3 (vision) — substance column. |
| `offer` | `text` | ✓ | slot 4 (vision) — substance column. |
| `elements` | `jsonb` | ✓ | **Agnostic wireframe** — array of `{zone: header\|hero\|body\|footer\|cta, role: hook\|mechanism\|proof\|offer\|risk_reversal\|social_proof\|price, prominence: 0..1}`. Scaffold-only; the raw substance stays in the four substance columns above. Shape-gated at the DB by `creative_skeletons_elements_shape_trigger` (BEFORE INSERT/UPDATE plpgsql trigger — replaces the invalid subquery-in-CHECK from migration `20261124120000`, which Postgres rejects). Written by `visionDeconstruct` / `visionDeconstructFrames` in [[../libraries/creative-skeleton]] on every ingest, then re-parsed against the same zone/role/prominence whitelist so an off-vocab element is DROPPED (never lands). Migrations `20261124120000` (columns) + `20261130120001` (trigger). See [[../specs/creative-skeleton-wireframe-extractor-and-backfill-actually-built]]. |
| `product_presentation` | `text[]` | — | default `'{}'` · vision-emitted tags describing how the product is shown: `packshot` \| `lifestyle` \| `founder` \| `none`. Parser drops off-vocab tags so the column stays clean. Migrations `20261124120000` (column) + writer in [[../libraries/creative-skeleton]] `ingestAd`. |
| `punchiness` | `text[]` | — | default `'{}'` · vision-emitted tags describing the copy cadence: `short_line` \| `pattern_interrupt` \| `number` \| `contrast`. Parser drops off-vocab tags. Migrations `20261124120000` (column) + writer in [[../libraries/creative-skeleton]] `ingestAd`. |
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
| `winner_tier` | `text` | ✓ | **REPURPOSED — OUR persistence tier** (not AdLibrary's, which came back "loser" for every major brand): `new` (<7d observed) \| `building` (7-20d) \| `proven` (≥21d) \| `retired` (`still_active=false`, competitor killed it). Computed by `deriveWinnerTier` on each re-observation. Migrations `20261022160000` (col) + `20261022170000` (repurpose). |
| `winner_score` | `numeric` | ✓ | **REPURPOSED — OUR observed persistence in DAYS** (`our_last_seen - our_first_seen`), not AdLibrary's opaque composite. The ranking signal for proven winners. Migration `20261022170000`. |
| `our_first_seen` | `timestamptz` | ✓ | winners-flow longitudinal: when OUR sweep FIRST observed this ad (set once by `ingestAd`; backfilled to `created_at` for pre-existing rows). Persistence = `our_last_seen − our_first_seen`. Migration `20261022170000`. |
| `our_last_seen` | `timestamptz` | ✓ | Most recent sweep we saw the ad live (bumped by `reobserveAd`). Migration `20261022170000`. |
| `observed_sweeps` | `integer` | — | default `1` · how many sweeps we've observed the ad in (`reobserveAd` ++). Migration `20261022170000`. |
| `still_active` | `boolean` | — | default `true` · present in its competitor's latest sweep. `markDisappearedAds` sets it `false` (→ `winner_tier='retired'`) when the ad vanishes. Migration `20261022170000`. |
| `concept_tags` | `jsonb` | ✓ | **The unified concept breakdown** — `{ angle, archetype, why_it_works, cialdini_lever, awareness_stage, format }`. ALWAYS from OUR vision (both lanes), so Dahlia researches + Max grades one shape. AdLibrary's own tags were dropped — they were mislabeled (`angle`="solution_aware", `awareness_stage`="warm" = a temperature). Migration `20261022160000`. |
| `do_not_use` | `boolean` | — | default `false` · **per-ad exclusion flag** ([[../specs/flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded]] Phase 1). A proven long-runner is NOT automatically a good imitation base (Magic Mind display-box packshot vs. Onnit "Lock in when it matters most" — same tier, only one worth imitating). When `true`, [[../libraries/creative-sourcing]] `queryProvenAngles` filters this row out so Dahlia never riffs on a lame competitor ad. Preserved across scout re-observation by design — `ingestAd`'s upsert row and `reobserveAd`'s update SET clause do not include this column. Migration `20261119120000`. |
| `do_not_use_reason` | `text` | ✓ | why this ad was flagged (e.g. `max_weak_imitation_base` from the Phase-3 auto-flag, or a CEO-written note). Migration `20261119120000`. |
| `do_not_use_by` | `text` | ✓ | who flagged it — `'ceo'` for a manual CEO flag from the competitor library page, `'max'` for the Phase-3 imitation-quality grader's auto-flag (still surfaced for CEO review — never a silent proxy-optimizer). Migration `20261119120000`. |
| `do_not_use_at` | `timestamptz` | ✓ | when the flag was set. Migration `20261119120000`. |
| `status` | `text` | — | default `'analyzed'` · `pending` \| `analyzed` \| `video_pending` \| `shortlisted` \| `archived` \| `failed` |
| `raw` | `jsonb` | ✓ | full AdLibrary row for replay/audit |
| `visioned_at` | `timestamptz` | ✓ | when the skeleton was extracted |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, source, dedup_key)` — the idempotent upsert key.
**Indexes:** `(workspace_id, status)`, `(workspace_id, advertiser)`, `(workspace_id, days_running desc)`, `(workspace_id, destination_domain) WHERE destination_domain IS NOT NULL` ([[../specs/landing-page-scout]] read path), `(product_id)`, `(competitor_id)` (per-product scout read path, migration `20261020120000`), `(workspace_id, winner_tier) WHERE winner_tier IS NOT NULL` (migration `20261022160000`), `(workspace_id, still_active, winner_score desc) WHERE source='adlibrary'` (winners-flow persistence ranking, migration `20261022170000`), `(workspace_id, product_id) WHERE do_not_use` (flag-a-competitor-ad-do-not-use Phase 1 exclusion scan, migration `20261119120000`).

> **Deliberate-scout reset (2026-07-12).** Migration `20261020120000` added `product_id` + `competitor_id` and **hard-cleared all 473 pre-refactor rows** (`delete where product_id is null`) — they predated product tagging and weren't re-derivable. HARD delete (not archive) because the pattern-matrix / promotion scans read `source='adlibrary'` with no status filter. The [[../inngest/creative-scout]] repopulates per-product, tagged. This is the "clean the competitive ad library" step of the base-layer imitate→innovate fix.

## RLS

- `creative_skeletons_select` — `authenticated` read where `workspace_id` ∈ caller's `workspace_members`.
- `creative_skeletons_service` — `service_role` full. All writes go through `createAdminClient()`.

## Gotchas

- **Statics are visioned at ingestion** (`status='analyzed'`); **videos are routed aside** (`status='video_pending'`) and then drained by the **video pipeline** ([[../libraries/video-skeleton]] · [[../specs/creative-finder-video]]) — `creative-finder-video-process` downloads → ffmpeg keyframes + Whisper transcript → the same four-slot skeleton and flips the row to `analyzed` (or `failed`). The status flip is the dedup: a video `ad_key` is processed once.
- The matrix counts **distinct `advertiser`s** — repetition across independent brands is the signal, never one ad's `heat`/`days_running` (those are tiebreakers only).
- **Display serves OUR hosted copy, not AdLibrary.** `image_url` 403s without the Bearer key AND is full-res (6–22MB) — live-proxying it 502'd (serverless response-size limit). So `ingestAd` stores a downscaled analyzable copy in the private `creative-shots` bucket (`thumb_path`) and the list route returns a signed URL to it. `/api/ads/creative-finder/media` remains only as a downscaling fallback for legacy rows without `thumb_path`.
- **Full payload from `ingestAd`, not vision** — `destination_domain`/copy/CTA/spend/engagement/`platform` columns come straight from the AdLibrary row ([[../specs/ad-creative-scout]]); only `format`/`framework`/`hook`/`mechanism_claim`/`proof`/`offer` are vision-extracted. `destination_domain` is null for ads with no store url (`has_store_url=false`).
- **Wireframe redesign (2026-11-24).** The substance columns (`hook`, `mechanism_claim`, `proof`, `offer`) stay for the analyzed-competitor archive — they carry the raw phrases the vision pass pulled off the ad and remain the input the M4 reuse-verdict helper diffs against — but the `elements[]` scaffold is the shape readers should prefer for reuse decisions. The v3 recast is deliberate: skeleton is scaffold-not-substance, so per-copy-section reuse verdicts are computed at AUTHOR time (never stored) against the product's *current* intelligence. New readers building on skeletons should read `elements[]` + `product_presentation` + `punchiness`; only legacy readers (pattern matrix, dedup) still key off the substance columns. Migration `20261124120000` · [[../specs/skeleton-agnostic-wireframe-redesign]] Phase 1.
- **Wireframe extractor / shape-trigger correction (2026-11-30).** The original wireframe migration's shape gate was a `CHECK (... NOT EXISTS (SELECT 1 FROM jsonb_array_elements(...)))` — Postgres forbids a subquery inside a CHECK ("cannot use subquery in check constraint"), so the whole ALTER TABLE failed and the columns only existed via a manual column-only apply on 2026-07-22. Migration `20261130120001` (creative-skeleton-wireframe-extractor-and-backfill-actually-built Phase 1) replaces that with a BEFORE INSERT/UPDATE plpgsql trigger `creative_skeletons_check_elements_shape` that walks `NEW.elements` and raises `22023` on any element that isn't a jsonb object OR is missing zone/role/prominence OR has an off-whitelist zone/role OR has a non-number prominence outside [0, 1]. Phase 2 (the same spec) then wires the extractor: `visionDeconstruct` / `visionDeconstructFrames` in [[../libraries/creative-skeleton]] now emit + persist `elements` / `product_presentation` / `punchiness` on every ingest (the columns were dead until this ships). See [[../specs/creative-skeleton-wireframe-extractor-and-backfill-actually-built]].

## Written by
[[../libraries/creative-skeleton]] (`ingestAd`) ← [[../inngest/creative-finder]]; [[../libraries/video-skeleton]] (`processVideoPending` updates `video_pending` → `analyzed`) ← [[../inngest/creative-finder]] (`creative-finder-video-process`).

## Read by
[[../libraries/creative-skeleton]] (`buildPatternMatrix`, dedup) · [[../libraries/ad-gap]] (`buildAdGapReport` — angle gaps) · [[../libraries/competitors]] (`promoteFromCategorySweep`) · `/api/ads/creative-finder*` routes · [[../specs/landing-page-scout]] (`destination_domain` per approved competitor).

## Related
[[../specs/winning-static-creative-finder]] · [[../specs/ad-creative-scout]] · [[../integrations/adlibrary]] · [[../libraries/adlibrary]] · [[../libraries/ad-gap]] · [[../inngest/creative-finder]] · [[../functions/growth]]
