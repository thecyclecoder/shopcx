# `advertorial_pages` — generated ad-matched lander tops

One row per (product, ad angle, variant) = the generated editorial **TOP** of a lander (hero + chapter 1). Everything below the top is the existing PDP, reused unchanged at render time. Written by [[../libraries/advertorial-pages]] `generateAdvertorialPagesForCampaign` (auto-triggered when a campaign hits `ready`, [[../inngest/ad-tool]] `adToolAdvertorialPageRequested`); read by the storefront route via `loadAdvertorialContent`. Migration `20260615120000_advertorial_pages.sql`. RLS: workspace-member SELECT, service-role write. See [[../lifecycles/advertorial-landers]].

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` / `product_id` | uuid → workspaces / products | cascade |
| `angle_id` | uuid → [[product_ad_angles]] | the angle this lander matches (nullable) |
| `campaign_id` | uuid → [[ad_campaigns]] | the campaign whose assets seeded it (nullable) |
| `slug` | text | URL `?angle={slug}` — `{hook_slug}-{angle_id[:8]}` (before/after appends `-ba`) |
| `variant` | text | `advertorial` \| `beforeafter` |
| `publication` | text | brand-owned masthead (never a real outlet) |
| `sponsor_label` | text | "SPONSORED" honesty label |
| `headline` / `dek` | text | editorial serif hero headline + standfirst |
| `hero_kind` | text | `avatar` \| `ingredient` \| `beforeafter` |
| `hero_storage_path` | text | **re-signable** `ad-tool` bucket path (NOT a signed URL); null → resolve from `product_media` |
| `hero_caption` | text | italic photo caption |
| `chapter_heading` | text | chapter-1 heading |
| `chapter_paragraphs` | jsonb | chapter-1 paragraphs (string[]) |
| `sticky_nav` | jsonb | optional jump-nav config |
| `status` | text | `draft` \| `ready` |
| `created_at` / `updated_at` | timestamptz | |

**Unique:** `(workspace_id, product_id, slug)` — upsert target, so re-running a campaign of the same angle refreshes rather than duplicates. Index on `(product_id, slug)` (render lookup) + `angle_id`.

## Gotchas
- **Per angle, reused across campaigns/ads of that angle** — not per campaign.
- **Hero is a path, not a URL** — only re-signable `ad-tool` paths are stored; expiring signed URLs are dropped (the reader re-signs fresh, 1h TTL). Ingredient/before-after heroes are null here and resolve from `product_media` at render.
- **Generated top only** — ingredients/pricing/reviews/checkout are the live PDP, never copied into this row.
