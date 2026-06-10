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
- Brain libs: `src/lib/social/{publish,generate-caption,resources,seasonality,optimizer,insights}.ts`.
- Inngest: `socialSchedulerPlan` (daily plan), `socialPublish` (per post), `socialInsightsSync` (daily metrics).

## Why we can do this

A live test (2026-06-10) proved the existing page tokens publish organic content on **both** platforms — no new OAuth scopes (the granted tokens already carry `pages_manage_posts` + `instagram_content_publish`, despite the [[../integrations/meta-graph]] scope list not documenting them).

## Phase 1 — plan (daily cron `socialSchedulerPlan`, 09:00 UTC)

For each workspace with `enabled` + `target_meta_page_ids`:

1. Load the optimizer signals once (`loadSlotSignals`).
2. For each of the next 7 days (rolling horizon — each run adds the new day-7):
   - Weekday cadence: **story daily, feed Mon/Wed/Fri/Sun, reel Tue/Thu/Sat** (= 7 stories + 4 feeds + 3 reels/week).
   - Seed per-platform `dayCount` + per-page taken-hours from rows already on that day (idempotent — skip a (type, day) already planned).
   - Load the active promo covering the date (themes captions; may lift the cap).
   - Per type: pick the source kind (reel→ad_video; feed→avatar/testimonial/resource; story→avatar/testimonial), `pickBySourceKind` (rotates, skips recently-used + off-season resources), generate a PI-grounded caption (`generateCaption`, season + promo aware).
   - Cross-post one asset/caption to every target page: enforce the **per-platform daily cap** (default 3), pick the time via `pickBestSlot`, insert a `scheduled_social_posts` row, fire `social/publish`. `require_approval` → rows land as `draft` (no event until approved).

## Phase 2 — publish (per-post `socialPublish`)

`step.sleepUntil(scheduled_at)` → **re-read the row** (honors dashboard edits / cancels — only `scheduled` proceeds) → `status='publishing'` → `publishScheduledPost`:

- Resolve a fresh media URL: private `ad-tool` assets are re-signed (1h) so Meta can fetch; resource images pass through public.
- FB feed → `POST /{page}/photos`. IG feed → `/media` + `/media_publish`. IG reel → `/media` (REELS) + **poll status_code until FINISHED** + publish. IG story → `/media` (STORIES, media-only — no caption/overlay via API) + publish.
- Record `posted` (+ platform id + permalink) or `failed` (+ error). retries=2.

## Phase 3 — measure + optimize (daily `socialInsightsSync`, 08:30 UTC)

- Per-post engagement (reach/likes/comments/saves/shares) pulled from Graph insights onto the row (IG: media fields + insights; FB: post fields). Defensive parsing — shapes vary by media type / version.
- Audience-online heatmap per IG page (`online_followers`) → [[../tables/social_audience_hours]] (0..23, normalized).
- The planner's `pickBestSlot` then scores each candidate slot ≈ `(0.5 + audience(hour)) × (1 + our-engagement-at(hour, type))`. Before any data, everything scores ~neutral → falls back to the configured slot order. `frequencyHint` flags the reach trend (post more / ease off) — surfaced, not auto-applied.

## Season + promo logic

- `isSeasonallyAppropriate(text, now)`: a resource with a clear seasonal/holiday signal only passes inside its window (windows carry lead time). Evergreen passes always. Applied to resource selection (ad assets are evergreen).
- `social_campaigns`: an operator adds a promo (name, window, brief). Active-on-date → `campaignBrief` flows into caption generation; `boost_per_platform_per_day` raises the cap for the window.

## Gotchas

- **Engine is opt-in + safe.** `enabled=false` + empty `target_meta_page_ids` by default — nothing posts until an operator configures Marketing › Social. The cron iterates all workspaces but skips unconfigured ones.
- **Cap is per platform per day** (3 default), not total. Promo boost is the only override.
- **IG stories are media-only** via Graph — no text/sticker/link overlay. Caption is stored but won't render on the story.
- **Private bucket media** must be re-signed at publish time; never persist a signed URL (it expires).
- **Meta Insights shapes** vary; Phase 5 parsing is defensive and **needs validation against live posted data** before the optimizer is fully trustworthy.
- Reuse rotation reads `scheduled_social_posts` history (default 21-day window) — no separate usage table.

## Status / open work

**Shipped (2026-06-10):** all five phases + season/promo layer + per-platform cap. Live test confirmed publishing on FB + IG.

**Open:** validate Insights parsing on real posted metrics; optional resource-performance weighting + true frequency auto-tune; FB reels/stories (currently FB = feed photos only); multi-brand rollout (Ashwavana pages exist).

## Related

[[../specs/automated-social-scheduler]] · [[../integrations/meta-graph]] · [[../tables/scheduled_social_posts]] · [[../tables/social_campaigns]] · [[../tables/social_audience_hours]] · [[../tables/ad_videos]] · [[../tables/posts]] · [[ad-render]]
