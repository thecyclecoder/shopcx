# organic_content

The **organic social library**, separate from the ads system — one row per organic asset in three formats: nugget **carousel** slideshows, animated **reel** cuts, and **review** highlights. The social scheduler reads organic content ONLY from here (never ad_campaigns / ad_videos). See [[../lifecycles/social-scheduler]] · [[../libraries/organic-content]].

**Primary key:** `id`
**Added:** organic-nugget-engine Phase 1 (migration `20270127130000_organic_content.sql`).

## Why it exists

Paid-ad creative is built to **sell**, not to be **shared**, and ad-side changes silently changed what the organic feed posted (the poster recycled `ad_campaigns` heroes, `ad_videos`, and review cards stored as fake "Reviews" ad campaigns). This table cuts that dependency: organic content is authored and curated on its own, away from the paid tables.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | → [[workspaces]] |
| `format` | text | `carousel` \| `reel` \| `review` |
| `pillar` | text | `body` \| `food_first` \| `superfoods` — **null for review** (CEO 2026-11-27 pillars) |
| `title` | text | internal/display title |
| `hook` | text | opening line / scroll-stopper |
| `slides` | jsonb | ordered `[{ headline, body, image_bucket, image_path }]`. A review has one rendered-card slide; a reel is empty (media is the video) |
| `dinner_line` | text | the one shareable "dinner table" takeaway |
| `study_citation` | text | one real, accurately-described study (nuggets) |
| `video_bucket`, `video_path` | text | reel media — private bucket, **re-signed at publish** |
| `product_id` | uuid | → [[products]] (ON DELETE SET NULL) |
| `review_id` | uuid | source `product_reviews.id` for review cards (idempotency key) |
| `status` | text | `draft` \| `approved` \| `retired` |
| `created_by` | text | `system` \| `featured_review_card` \| user id |
| `created_at`, `updated_at` | timestamptz | |

## Gotchas

- **Writes go through the SDK only** ([[../libraries/organic-content]] `insertOrganicContentDraft` / `setOrganicContentStatus`) — CLAUDE.md "raw `.from` with no SDK → STOP", enforced by `scripts/_check-organic-content-sdk-compliance.ts` (in `predeploy:static`).
- **Supervisable autonomy:** nuggets land `draft` (the generator proposes, a human approves in Marketing › Social). Review highlights are already human-featured, so the review mover inserts them `approved` to keep their auto-posting behaviour.
- **Never persist a signed URL** — slides/reels store `bucket`+`path` and are re-signed at publish per the scheduler's `resolveMediaUrl` rules.
- `scheduled_social_posts.source_kind='organic'` points `source_ref_id` at `organic_content.id`.

## Related

[[scheduled_social_posts]] · [[../libraries/organic-content]] · [[../lifecycles/social-scheduler]] · [[../README]]
