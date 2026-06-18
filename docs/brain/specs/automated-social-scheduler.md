# Automated Organic Social Scheduler ✅ (built — pending live config)

**Owner:** [[../functions/cmo]] · **Parent:** Cmo mandate "Organic social"

**Goal:** an always-on content engine that auto-plans and publishes organic **posts, reels, and stories** to the brand's Facebook + Instagram, on a rolling schedule, for **enhanced customer engagement** — plus a dashboard to see what's posted and what's queued.

**Status (2026-06-10):** all five phases shipped + the season/promo layer. Trace: [[../lifecycles/social-scheduler]]. The engine is OFF until an operator opens **Marketing › Social**, picks target pages, and toggles it on (safe by default — `enabled=false`, no `target_meta_page_ids`). Remaining = validate Meta Insights response shapes against live posted data (Phase 5 parsing is defensive but unverified end-to-end).

**Why now:** we already ingest + reply to social comments via the Meta Graph API. A live test (2026-06-10) proved our existing page tokens can **publish** organic content on both platforms (FB page photo + IG feed/reel/story) — no new OAuth scopes needed (the tokens already carry `pages_manage_posts` + `instagram_content_publish`, even though the [[../integrations/meta-graph]] scope list didn't document them). Sample posts of every type were published and approved by Dylan with no copy changes.

## Proven mechanics (from the test — reuse these)

| Type | Graph call | Notes |
|---|---|---|
| FB feed (image) | `POST /{page-id}/photos` `{url, caption}` | returns `{id, post_id}` |
| IG feed (image) | `POST /{ig-user}/media` `{image_url, caption}` → `POST /{ig-user}/media_publish` `{creation_id}` | two-step |
| IG reel (video) | `POST /{ig-user}/media` `{media_type:REELS, video_url, caption, share_to_feed:true}` → **poll** `GET /{creation_id}?fields=status_code` until `FINISHED` → publish | video processing takes ~10-30s; MUST poll |
| IG story | `POST /{ig-user}/media` `{media_type:STORIES, image_url|video_url}` → publish | **media-only** — Graph API can't add text/stickers/link overlays; any "copy" must be baked into the asset |

- **Tokens:** page access tokens in [[../tables/meta_pages]]`.access_token_encrypted` (decrypt via `src/lib/crypto`). FB page `104094194369069`, IG user `17841409041235543` (Superfoods Company); Ashwavana pages also present.
- **Media lives in a private bucket** (`ad-tool`) → signed URLs expire. **Re-sign a fresh 1-hour URL at publish time** for Meta to fetch. Resource (`posts`) images are in the public `product-media` bucket — use directly.
- **IG rate limit:** 25 published posts / 24h per IG account. Stay well under.

## Resources → post types → copy

Four content sources (all already in the DB):

1. **Avatar holding product** — `ad_campaigns.hero_image_url` (UGC-style image of an avatar holding the product). → **feed post** (and **story**).
2. **Finished ad videos** — [[../tables/ad_videos]] `final_mp4_url` where `status='ready'`, `format='reels_9x16'`. → **reel** (and **story**).
3. **Testimonial / review statics** — [[../tables/ad_videos]] where `media_kind='static'` AND `meta->>'archetype'='review'` (a 5★ testimonial card: real reviewer name + rating + quote + product, e.g. *Tamara L. ★★★★★ "I couldn't wake up without my mushroom coffee" — Verified Purchase*). Image = `static_jpg_url` or re-sign `meta.storage_path`. → **feed post** (and **story**). **Only the `review` archetype** — `offer` statics carry discount CTAs (promo, not engagement) and `benefit_authority` can fold in later.
4. **Resources** — [[../tables/posts]] (`is_resource`, e.g. recipes like the chai cookies) with `featured_image_url`. → **feed post**.

**Copy generation:** for the ad sources (avatar images + ad videos), generate the caption from the **real product intelligence** — `product_ingredients` + the PI engine (research/benefits) for the campaign/video's `product_id`. (Amazing Coffee → "12 superfoods + adaptogenic mushrooms — Chaga, Cordyceps… time-release caffeine, no 2pm crash.") **Testimonial statics:** the review is already baked into the image, so the caption *complements* it — brief social-proof framing + the PI-grounded benefit, never repeating the quote verbatim and never inventing claims. Resource posts caption from the post's own excerpt/summary. Generation via Anthropic with the PI as grounding; **never invent claims not in the PI**.

## Cadence (best-practice default, configurable)

Engagement-weighted toward reels + stories:
- **Reels: 3–4 / week** (highest reach/discovery on both platforms).
- **Stories: ~daily (5–7 / week)** (top-of-feed with existing customers; retention).
- **Feed posts: 3–4 / week** (evergreen: resources/recipes, avatar product shots).
- Skew reels mid-week; post mid-morning + early evening (store the time slots in workspace config).

## Timing + frequency optimization (how the planner maximizes engagement)

The cadence above is the **bootstrap default**. Once we have our own data, the planner stops guessing and optimizes from real audience behavior — same post → measure → bias-future-scheduling loop as the prompt-learning system.

**Time of day** — blend two signals, per post type:
1. **Audience-online heatmap** (Meta Insights): IG `GET /{ig-user}/insights?metric=online_followers&period=lifetime` (followers online by hour) + FB `page_fans_online_per_day`. When are *our* followers actually on?
2. **Our own historical performance**: every posted item logs its hour/day + engagement (reach, likes, comments, saves, shares) from `GET /{media-id}/insights` (IG) / `/{post-id}/insights` (FB). Aggregate → best-performing slots **per type** (reels, stories, feed peak at different times).
3. Planner scores each candidate slot ≈ `audience_online(hour) × historical_engagement(hour, type)` and assigns each post the highest-scoring **open** slot for its type, enforcing a min-spacing rule so posts don't clump. Before any data exists, fall back to the best-practice slots.

**Frequency** — start at the cadence config, then auto-tune within operator-set min/max:
- Bounded by IG's 25-posts/24h limit + a min-spacing rule.
- Watch the **per-post reach / engagement-rate trend**: if posting more keeps *total* engagement climbing without per-post reach collapsing → room to increase; if per-post reach falls as frequency rises (audience fatigue) → back off. Never exceeds the operator's ceiling.

This needs the per-post metrics pipeline (Phase 5) before it's fully data-driven; Phases 1–4 run on the best-practice defaults, then the optimizer takes over.

## Scheduling architecture — rolling 7-day window

- **7-day horizon.** The calendar is always filled 7 days out — enough to review/edit in the dashboard before anything publishes, not so far it goes stale.
- **Daily planner cron** (`social-scheduler/plan`, ~5am workspace TZ): tops the calendar up to 7 days ahead. Each run effectively adds the new "day 7," so the window rolls forward one day at a time (Dylan's "push it another day out"). The planner:
  1. Reads the cadence config → how many of each type the week needs.
  2. Picks resources round-robin, **avoiding recent re-use** (track `last_posted_at` per resource so we don't repeat an asset within N days).
  3. Generates copy from PI (for ad sources) or the post summary (resources).
  4. Inserts `scheduled_social_posts` rows with `scheduled_at` set to the cadence time slots, `status='scheduled'`.
  5. Fires a `social/publish` Inngest event per row.
- **Per-post publisher** (`social-publish` Inngest fn): `step.sleepUntil(scheduled_at)` → re-sign media URL → publish via the Graph calls above (poll for reels) → write `published_platform_id` + `status='posted'` (or `failed` + error). Durable; publishes at the right time of day. (Don't use a polling cron — Inngest sleepUntil is cleaner and already in the stack.)
  - **Transient-failure retry (2026-06-12):** Meta Graph errors split into **transient** (5xx / 429 / `is_transient` / codes 1,2,4,17,32,341,613 — "An unexpected error has occurred, please retry") vs **permanent** (bad media, policy, expired token). `publish.ts` tags each `PublishResult` with `retryable`. The publish step **throws on a transient error while `attempt < PUBLISH_RETRIES` (=4)** so Inngest retries with backoff; on the final attempt it returns the failure so `finalize` records it (never stuck in `publishing`). Permanent errors fail immediately. *Before this, a transient Meta hiccup permanently failed the post with no retry — 2 posts hit that on 6/12 and were reposted by hand.*
- **Edit window:** because the dashboard shows the whole 7-day buffer, an operator can edit caption / swap media / reschedule / cancel any `scheduled` row before its Inngest job fires (the publisher re-reads the row at fire time, so edits stick).

## Data model

**`scheduled_social_posts`**:
```
id, workspace_id
meta_page_id        → meta_pages.id           (which FB page / IG account)
platform            facebook | instagram
post_type           feed | reel | story
source_kind         avatar | ad_video | testimonial | resource
source_ref_id       campaign_id | ad_video_id | ad_video_id (review static) | post_id
product_id          → products.id             (for PI copy + attribution; null for non-product resources)
media_bucket, media_path                       (re-signed at publish; null if using a public URL)
media_url           public URL when applicable (resource images)
caption             generated copy
scheduled_at        timestamptz
status              draft | scheduled | publishing | posted | failed | skipped
published_platform_id   FB post_id / IG media id
published_at, error
created_by          system | <user_id>
created_at, updated_at
```
Plus a lightweight `last_posted_at` signal per resource (column on the source row or a small `social_resource_usage` table) so the planner rotates assets.

## Dashboard

`/dashboard/social` (or under Marketing):
- **Calendar + list view** of `scheduled_social_posts`: past (posted, with the live permalink) and upcoming (scheduled), filterable by platform / type / status.
- Inline **edit** of a scheduled item (caption, media, time) + **cancel** / **post-now** / **regenerate copy**.
- **"Plan next week" / pause toggle**, cadence config (counts + time slots per platform).
- Later: **engagement metrics** per posted item (likes/comments/reach via Graph insights) — the actual "enhanced engagement" scoreboard.

## Operator guardrails (added during build)

- **Per-platform daily cap** (`config.max_posts_per_platform_per_day`, default **3** — "start conservative, optimize from there"). Enforced in the planner per page/day; a promo's `boost_per_platform_per_day` can lift it for its window.
- **Season/holiday awareness** (`src/lib/social/seasonality.ts`): off-season resources (a fall chai recipe in June, a July-4th post in October) are skipped by the resource picker; captions get a date/season context so copy never references the wrong season. Holiday windows include lead time (July-4th content posts from ~June 20).
- **Promos** (`social_campaigns`): how an operator declares a holiday/seasonal campaign — name + date window + brief (+ optional product / cap boost). The planner reads the active promo per scheduled date and themes the captions around its brief.

## Phases — all shipped 2026-06-10

- **✅ Phase 1 — publish library:** `src/lib/social/publish.ts` + `scheduled_social_posts` migration.
- **✅ Phase 2 — copy generation:** `src/lib/social/generate-caption.ts` (PI-grounded, season-aware, promo-aware).
- **✅ Phase 3 — planner + publisher:** `src/lib/inngest/social-scheduler.ts` — `socialSchedulerPlan` daily cron (rolling 7-day window, weekday cadence, resource rotation, daily cap, promo theming) + `socialPublish` per-post fn. Resource rotation reads `scheduled_social_posts` history (no separate usage table).
- **✅ Phase 4 — dashboard:** `/dashboard/marketing/social` (Marketing › Social) — calendar/list, on/off, target pages, cadence + cap + approval, "Plan next 7 days", promos, per-post edit/approve/post-now/cancel.
- **✅ Phase 5 — engagement insights + optimizer:** `src/lib/social/insights.ts` + `src/lib/social/optimizer.ts` + `socialInsightsSync` daily cron. Per-post metrics + audience-online heatmap (`social_audience_hours`); planner picks each slot via `pickBestSlot` (audience × historical engagement, neutral fallback before data); `frequencyHint` surfaces the reach trend. Frequency stays operator-set (hint only) for now; resource-performance weighting is a future refinement.
- **✅ Phase 8 — link-in-bio feed `/links` (2026-06-11):** the IG/FB bio link can't be set via API, so we host `/links` (`store/[workspace]/links/page.tsx`) and set the bio to it once. It's an **Instagram-style feed of what we recently posted** — each entry shows the **exact image we posted** (so a viewer recognizes it from memory) plus the full content below. Source of truth is `scheduled_social_posts` (status='posted') — the poster already records the post image (`media_*`, re-signed for private buckets) + the content linkage (`source_ref_id`), so nothing extra to write. Loader `_lib/link-in-bio.ts` resolves each post type → an entry, newest first, deduped by content: **review** (testimonial `source_ref_id` → `ad_videos.meta.review_id` → review) shows the card image + the **full review text** the card truncated + Shop {Product}; **blog post** → image + post link + Shop {Product}; **avatar/reel** → image + Shop {Product}; **promo** → image + offer + Shop {Product}. Falls back to recent posts so it's never empty. Card CTA reads "Click link in bio for full review →". Future: order/feature by the active promo; a denormalized snapshot if we want the content frozen at post time.
- **✅ Phase 7 — featured-review card generator (2026-06-11):** the social poster was limited to whatever review statics already existed in the ad library. Now a daily cron **generates** designed testimonial graphics from ShopCX **featured** reviews (`product_reviews.featured`) and drops them into the ad library so the poster picks them up via `pickTestimonial` (no poster changes) and the ad tool can reuse them. `src/lib/social/featured-review-cards.ts` `generateFeaturedReviewCards(ws, max=3)`: pick uncarded featured reviews (round-robin across products for variety) → find-or-create a **"{Product} Reviews"** `ad_campaigns` row (no schema change — cards live under a real campaign so `pickTestimonial` resolves the product) → render the ad-tool's **`StaticReview` Remotion template** (text-exact, on-brand) at **9:16 + 4:5** → store as `ad_videos` statics (`media_kind='static'`, `meta.archetype='review'`, `meta.source='featured_review_card'`, `meta.review_id`). Product image = `isolated_image_url`, **falling back to the main variant `image_url`**. **Idempotent + finite:** tracks carded reviews via `meta.review_id`, so it does a few/day and **stops once every featured review has a card**. Cron `src/lib/inngest/featured-review-cards.ts` (`0 11 * * *`, + `featured-review-cards/tick`), 3/day. (Template reuses the existing ad `StaticReview` design; can be retuned to match the storefront card exactly later.)
- **✅ Phase 6 — story 9:16 enforcement (2026-06-11):** Stories are 9:16; posting a square/portrait avatar or testimonial image makes Meta zoom-crop it (text cut, product oversized). `src/lib/social/story-ratio.ts` `ensureStoryRatio` measures the story image (sharp) and, when it's not ~9:16, **extends it with Nano Banana Pro** (outpaint the scene above/below — never crop/zoom the subject) to a clean 1080×1920, uploads it public, and points the post at it. Run **at schedule time** in the planner (the story branch), not at publish — generation is slow + failable, and publishing must stay deterministic + previewable. Promo story graphics are already 9:16 (`mediaUrl` set, no bucket/path) → no-op. **Promo graphics already generate both `feed` 4:5 + `story` 9:16** (`promo-graphics.ts`) — verified the active 4th-of-July promo has both at correct ratios.

## Open questions

- **Approval gate or auto-publish?** Default to auto-publish with the 7-day editable buffer as the review window (matches the blog-resources "edit after the fact" stance). Add a per-workspace "require approval" toggle if Dylan wants a hard gate.
- **Multi-brand:** Phase 1 = Superfoods Company (FB + IG). Ashwavana pages exist — fold in once the engine is proven.
- **Stories text:** Graph can't overlay text on stories. Either accept media-only stories, or (later) compose a story-formatted image with baked-in copy via the existing ad-render static pipeline.

## Related

[[../integrations/meta-graph]] · [[../tables/meta_pages]] · [[../tables/posts]] · [[../tables/ad_videos]] · [[../lifecycles/ad-render]] · [[../tables/product_ingredients]]
