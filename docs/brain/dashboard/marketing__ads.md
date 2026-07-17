# Dashboard · marketing/ads

The **read-only** window into the autonomous ad system. Ads are authored by **Dahlia** (copy + 3
placement statics) and graded by **Max** — this surface does **not** create or edit ads. The list is
a library of every creative; the detail page is a full-ad **lifecycle preview**.

> **read-only-repurpose (2026-07-17):** the detail page + list were repurposed from a manual
> ad-builder into a read-only preview. The `/new` + `/upload` manual-creation entry points were
> removed from the list; the detail page's staged production UI (hero → talking-head → b-roll →
> render), the b-roll studio, the static-generate buttons, and the `PublishToMeta` form were all
> removed. Ads come from Dahlia now, so the page **shows** — it doesn't build.

**Route:** `/dashboard/marketing/ads` · **owner/admin only** (the GET route gates on
`workspace_members.role ∈ {owner, admin}`).

## The list — `page.tsx`

A library grid of every `ad_campaigns` row (thumbnail + product + status), each linking to its detail
page. Tiles above it: **Avatars**, **Winning statics**, **Shadow reviews**, **Settings**. A hover
**Delete** stays as library housekeeping (cascades child rows; the generated lander survives). No
"New ad" / "Upload" tiles — creation is Dahlia's job.

## The detail page — `[id]/page.tsx` (read-only lifecycle preview)

One fetch (`GET /api/ads/campaigns/[id]`) drives five read-only sections:

1. **Source (explore / exploit)** — what the ad is built from, read off `product_ad_angles.metadata.provenance`
   ([[../tables/product_ad_angles]], written by [[../libraries/creative-agent]] `buildAngleProvenance`):
   - **Explore** — a `source:'competitor'` angle imitating a rival's winning ad: shows the competitor
     **advertiser**, the competitor **ad image** (`raw.imageUrl`, the design-transfer reference), and
     the rival's **raw hook** (pre-debrand) next to our angle.
   - **Exploit** — every other source (`review_cluster` / `transformation` / `benefit` / `ingredient` /
     `authority` / `ad_angle`): an own proven asset, shown as a human label + the angle.
2. **The ad** — the 3 placement statics (`feed_4x5` · `stories_9x16`|`reels_9x16` · `right_column_1x1`
   from [[../tables/ad_videos]], `media_kind='static'`), a Meta-feed **ad mock** (page identity +
   canonical copy + CTA), the **copy variations** (temperature-banded from
   [[../tables/ad_creative_copy_variants]] when present, else the angle's `metadata.copy_pack`), and
   the **FB/IG page** it posts as ([[../tables/meta_pages]], resolved from the latest publish job's
   `meta_page_id`).
3. **Max's grade** — Dahlia's `author_self_score` (5-lens 0-2 rubric + total, on [[../tables/ad_campaigns]])
   then Max's latest copy-QC verdict from [[../tables/ad_creative_copy_qc_verdicts]] (hard gates +
   persuasion + scroll-stop + the `verdict_reason` suggestion), read via [[../libraries/creative-qa]]
   `readLatestCopyQaVerdict` (the read chokepoint — a raw `.from(...)` select is a lint-fail).
4. **Meta lifecycle** — for each [[../tables/ad_publish_jobs]] row: account → campaign → adset → ad
   (bare Meta ids), with an "Open in Ads Manager" deep-link when `meta_ad_id` is set. Empty state
   until Bianca ships the creative into a test.
5. **Video outputs** — legacy read-only back-compat; only renders when a campaign has `media_kind='video'` rows.

Every section degrades to an empty state, so a creative renders before **and** after Dahlia/Max/Bianca
have touched it.

## API — `/api/ads/campaigns/[id]` (GET)

Returns `{ campaign, videos, segments, brollSources, publishJobs, copyVariants, angle, copyQaVerdict,
pageIdentity }`. `copyVariants` via [[../libraries/ad-copy-variants]] `readCopyVariants`; `copyQaVerdict`
via [[../libraries/creative-qa]] `readLatestCopyQaVerdict`; `angle` is a scoped read of the campaign's
`product_ad_angles` row (canonical caption + `metadata.copy_pack` + `metadata.provenance`); `pageIdentity`
resolves the latest publish job's `meta_page_id` against `meta_pages`. `publishJobs` widened to the full
Meta target chain. PATCH/DELETE stay (DELETE backs the list's housekeeping button).

## Files touched

- `src/app/dashboard/marketing/ads/page.tsx` — the read-only library list
- `src/app/dashboard/marketing/ads/[id]/page.tsx` — the read-only lifecycle preview
- `src/app/api/ads/campaigns/[id]/route.ts` — widened GET
- `src/lib/ads/creative-agent.ts` — `buildAngleProvenance` (persists `metadata.provenance`)
- `src/lib/ads/creative-qa.ts` — `readLatestCopyQaVerdict` (QC-verdict read chokepoint)

## Sub-routes

- `[id]/` → the lifecycle preview (above)
- `avatars/` → [[marketing/ads/avatars]]
- `winning/` → [[marketing/ads/winning]]
- `shadow-reviews/` → media-buyer shadow concur/dissent

> `new/` + `upload/` route files still exist but are no longer linked from the UI (manual-creation
> retired). A later cleanup can delete them; leaving them is inert.

---

[[../README]] · [[../../CLAUDE]] · [[../libraries/creative-agent]] · [[../lifecycles/ad-render]] · [[../lifecycles/ad-publish]]
