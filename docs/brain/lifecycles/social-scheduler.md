# Automated social scheduler

End-to-end trace of the always-on organic content engine: plan → publish →
measure → optimize, posting to Facebook + Instagram. Built 2026-06-10 (spec:
[[../specs/automated-social-scheduler]]). OFF until an operator configures it.

## Cast

- Dashboard: `/dashboard/marketing/social` (Marketing › Social) + `/api/workspaces/{id}/social/*`.
- Config: `workspaces.social_scheduler_config` (enabled, cadence, time_slots, daily cap, approval, **target_meta_page_ids**, reuse days).
- Calendar: [[../tables/scheduled_social_posts]] (one row per planned/published post).
- Promos: [[../tables/social_campaigns]] (operator-declared seasonal campaigns).
- Optimizer data: [[../tables/social_audience_hours]] + engagement columns on `scheduled_social_posts`.
- Content sources: `ad_campaigns.hero_image_url` (avatar), [[../tables/ad_videos]] (reels + review/testimonial statics), [[../tables/posts]] (blog resources).
- Publish: Meta Graph v21 (`src/lib/social/publish.ts`). Tokens: [[../tables/meta_pages]]`.access_token_encrypted`.
- Brain libs: `src/lib/social/{publish,generate-caption,resources,seasonality,optimizer,insights,story-ratio,featured-review-cards,promo-graphics}.ts`.
- Inngest: `socialSchedulerPlan` (daily plan), `socialPublish` (per post), `socialInsightsSync` (daily metrics), `featuredReviewCardsCron` (daily review-card generator, `0 11 * * *`).
- Link-in-bio: storefront `/store/{workspace}/links` (`src/app/(storefront)/store/[workspace]/links/page.tsx` + `_lib/link-in-bio.ts`).

## Why we can do this

A live test (2026-06-10) proved the existing page tokens publish organic content on **both** platforms — no new OAuth scopes (the granted tokens already carry `pages_manage_posts` + `instagram_content_publish`, despite the [[../integrations/meta-graph]] scope list not documenting them).

## Phase 1 — plan (daily cron `socialSchedulerPlan`, 09:00 UTC)

For each workspace with `enabled` + `target_meta_page_ids`:

1. Load the optimizer signals once (`loadSlotSignals`).
2. For each of the next 7 days (rolling horizon — each run adds the new day-7):
   - Weekday cadence: **daily blog + story daily, feed Mon/Wed/Fri/Sun, reel Tue/Thu/Sat** (= 7 blogs + 7 stories + 4 feeds + 3 reels/week).
   - Seed per-platform `dayCount` + per-page taken-hours from rows already on that day (idempotent — skip a (type, day) already planned).
   - Load the active promo covering the date (themes captions; may lift the cap).
   - **Daily blog slot (always-on, added first):** `source_kind='blog'`, `post_type='feed'`, cross-posted to IG feed + FB. `pickNewestBlog` returns the freshest published `is_resource` post the brand hasn't recently posted (newest-first + reuse-aware, so the 7-day window spreads distinct recent articles and a brand-new blog goes out the soonest open day). Image = the post's 4:5 `social_image_url` (auto-blog always generates one; older `shopify_blog` imports fall back to the landscape hero). It carries `link_url` (`https://{storefront_domain}/blog/{handle}`) → **FB renders a clickable link card** (`POST /{page}/feed {message, link}`, OG image from the article); IG can't link so the caption says "link in bio". Idempotency keys on `source_kind='blog'` (it shares `post_type='feed'` with the rotating feed). **Exempt from the daily cap** — it's the priority diversity slot.
   - Per type: pick the source kind (reel→ad_video; feed→avatar/testimonial/resource; story→avatar/testimonial), `pickBySourceKind` (rotates, skips recently-used + off-season resources), generate a PI-grounded caption (`generateCaption`, season + promo aware). Regular feed idempotency keys on `post_type='feed'` **excluding** the blog row.
   - Cross-post one asset/caption to every target page: enforce the **per-platform daily cap** (default 3; blog exempt), pick the time via `pickBestSlot`, insert a `scheduled_social_posts` row, fire `social/publish`. `require_approval` → rows land as `draft` (no event until approved).

## Phase 2 — publish (per-post `socialPublish`)

`step.sleepUntil(scheduled_at)` → **re-read the row** (honors dashboard edits / cancels — only `scheduled` proceeds) → `status='publishing'` → `publishScheduledPost`:

- Resolve a fresh media URL: private `ad-tool` assets are re-signed (1h) so Meta can fetch; resource images pass through public.
- FB blog (has `link_url`) → `POST /{page}/feed {message, link}` (clickable link card, OG image from the article). FB feed photo → `POST /{page}/photos`. IG feed → `/media` + `/media_publish`. IG reel → `/media` (REELS) + **poll status_code until FINISHED** + publish. IG story → `/media` (STORIES, media-only — no caption/overlay via API) + publish.
- Record `posted` (+ platform id + permalink) or `failed` (+ error).
- **Transient-vs-permanent retry (2026-06-12):** `publish.ts` tags each `PublishResult` with `retryable` — transient (5xx / 429 / `is_transient` / Meta codes 1,2,4,17,32,341,613) vs permanent (bad media, policy, expired token). With `PUBLISH_RETRIES=4`, the step **throws on a transient failure while `attempt < PUBLISH_RETRIES`** so Inngest retries with backoff; on the final attempt it returns the failure so `finalize` records `failed` (never stuck in `publishing`). Permanent errors fail immediately. (Before this, a single Meta hiccup permanently failed the post — 2 posts hit it on 6/12 and were reposted by hand.)

## Phase 3 — measure + optimize (daily `socialInsightsSync`, 08:30 UTC)

- Per-post engagement (reach/likes/comments/saves/shares) pulled from Graph insights onto the row (IG: media fields + insights; FB: post fields). Defensive parsing — shapes vary by media type / version.
- Audience-online heatmap per IG page (`online_followers`) → [[../tables/social_audience_hours]] (0..23, normalized).
- The planner's `pickBestSlot` then scores each candidate slot ≈ `(0.5 + audience(hour)) × (1 + our-engagement-at(hour, type))`. Before any data, everything scores ~neutral → falls back to the configured slot order. `frequencyHint` flags the reach trend (post more / ease off) — surfaced, not auto-applied.

## Season + promo logic

- `isSeasonallyAppropriate(text, now)`: a resource with a clear seasonal/holiday signal only passes inside its window (windows carry lead time). Evergreen passes always. Applied to resource selection (ad assets are evergreen).
- `social_campaigns`: an operator adds a promo (name, window, brief). Active-on-date → `campaignBrief` flows into caption generation; `boost_per_platform_per_day` raises the cap for the window.

## Story 9:16 enforcement (`story-ratio.ts`)

Stories render 9:16; posting a square/portrait avatar or testimonial image makes Meta zoom-crop it (text cut, product oversized). `ensureStoryRatio` measures the story image (sharp) and, when it isn't ~9:16, **extends it with Nano Banana Pro** (outpaints the scene above/below — never crops/zooms the subject) to a clean 1080×1920, uploads it public, and points the post at it. Runs **at schedule time** in the planner's story branch (not at publish — generation is slow + failable, and publishing must stay deterministic + previewable). Promo story graphics are already 9:16 (`mediaUrl` set, no bucket/path) → no-op.

## Featured-review card generator (`featured-review-cards.ts` + `featuredReviewCardsCron`)

The poster was limited to whatever review statics already existed in the ad library. The daily cron (`0 11 * * *`, also `featured-review-cards/tick`, 3/day) **generates** designed testimonial graphics from ShopCX **featured** reviews (`product_reviews.featured`) and drops them into the ad library so `pickTestimonial` picks them up with **no poster changes**. `generateFeaturedReviewCards(ws, max=3)`: pick uncarded featured reviews (round-robin across products) → find-or-create a **"{Product} Reviews"** `ad_campaigns` row (no schema change — cards live under a real campaign so `pickTestimonial` resolves the product) → render the ad-tool's **`StaticReview` Remotion template** at 9:16 + 4:5 → store as [[../tables/ad_videos]] statics (`media_kind='static'`, `meta.archetype='review'`, `meta.source='featured_review_card'`, `meta.review_id`). Product image = `isolated_image_url`, falling back to the main variant `image_url`. **Idempotent + finite:** tracks carded reviews via `meta.review_id`, so it does a few/day and stops once every featured review has a card.

## Link-in-bio feed (`/store/{workspace}/links`)

The IG/FB bio link can't be set via API, so we host `/links` and set the bio to it once. It's an **Instagram-style feed of what we recently posted** — each entry shows the **exact image we posted** plus the full content below. Source of truth is [[../tables/scheduled_social_posts]] (`status='posted'`) — the poster already records the post image (`media_*`, re-signed for private buckets) + the content linkage (`source_ref_id`), so nothing extra to write. Loader `_lib/link-in-bio.ts` resolves each post type → an entry, newest first, deduped by content: **review** (testimonial `source_ref_id` → `ad_videos.meta.review_id` → review) shows the card image + the **full review text** + Shop {Product}; **blog** → image + post link + Shop {Product}; **avatar/reel** → image + Shop {Product}; **promo** → image + offer + Shop {Product}. Falls back to recent posts so it's never empty.

## Gotchas

- **Engine is opt-in + safe.** `enabled=false` + empty `target_meta_page_ids` by default — nothing posts until an operator configures Marketing › Social. The cron iterates all workspaces but skips unconfigured ones.
- **Cap is per platform per day** (3 default), not total. Promo boost is the only override.
- **IG stories are media-only** via Graph — no text/sticker/link overlay. Caption is stored but won't render on the story.
- **Private bucket media** must be re-signed at publish time; never persist a signed URL (it expires).
- **Meta Insights shapes** vary; Phase 5 parsing is defensive and **needs validation against live posted data** before the optimizer is fully trustworthy.
- Reuse rotation reads `scheduled_social_posts` history (default 21-day window) — no separate usage table.

## Status / open work

**Shipped (2026-06-10):** all five phases + season/promo layer + per-platform cap. Live test confirmed publishing on FB + IG.

**Shipped (2026-06-11):** **story 9:16 enforcement** (`story-ratio.ts`, Nano Banana Pro outpaint at schedule time), **featured-review card generator** (`featured-review-cards.ts` + `featuredReviewCardsCron`, designs testimonial graphics from `product_reviews.featured` into the ad library), **link-in-bio feed** (`/store/{workspace}/links`, IG-style feed of recently posted content).

**Shipped (2026-06-12):** **transient-vs-permanent publish retry** (`PUBLISH_RETRIES=4`, `retryable` tag on `PublishResult`) — Meta hiccups now retry with backoff instead of permanently failing.

**Shipped (2026-06-16):** always-on **daily blog slot** (newest-first, IG feed + FB) with **FB clickable link cards** to the article (`link_url` column + `publishFacebookLink`). Exempt from the daily cap.

**Verified in production (2026-06-18):** owner-confirmed working; spec folded + archived ([[../archive]]).

**Open:** validate Insights parsing on real posted metrics; optional resource-performance weighting + true frequency auto-tune; FB reels/stories (currently FB = feed photos + blog link cards only); multi-brand rollout (Ashwavana pages exist).

## Related

[[../specs/automated-social-scheduler]] · [[../integrations/meta-graph]] · [[../tables/scheduled_social_posts]] · [[../tables/social_campaigns]] · [[../tables/social_audience_hours]] · [[../tables/ad_videos]] · [[../tables/posts]] · [[ad-render]]
