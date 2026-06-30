# Chapter Performance table mislabels the shared hero across lander variants

**Owner:** [[../functions/growth]] · **Parent:** [[growth]] mandate — Max's storefront performance data must be 100% accurate before he directs traffic on it.
**Status:** ⏳ planned — logged 2026-06-30, deferred ("we'll come back to this").

## Symptom (observed 2026-06-30, Funnel dashboard → Chapter Performance)
"Advertorial Hero" shows as the top chapter (reach 14, 73.7%), but on this day there were **0 advertorial-variant sessions** — the traffic was **16 reasons + 1 beforeafter + 5 bare PDP** (real traffic, internal/bots excluded). The "Advertorial Hero" reach is actually the **reasons listicle's hero**.

## Root cause
The reasons listicle (and beforeafter) pages **reuse the `AdvertorialHero` component** as their hero. It is hard-stamped `data-section="advertorial-hero"` (`src/app/(storefront)/_sections/AdvertorialHero.tsx:36`; the comment at :39 confirms the reuse "on the reasons listicle and any other"). 

The Chapter Performance table groups `chapter_view` events **purely by `data-section` id** and humanizes it via `fmtChapter` (`src/app/dashboard/storefront/funnel/page.tsx:1153`) → "Advertorial Hero". There is **no lander-variant dimension** in the aggregation, so the shared hero collapses every variant's hero views into one mislabeled "Advertorial Hero" row. The "Reasons Listicle" row (reach 3) is the listicle *body* section (`data-section="reasons-listicle"`), not the hero — so the hero of the reasons page is invisible as such.

Chapter-view aggregation: `src/app/api/workspaces/[id]/storefront-funnel/route.ts:280,298` reads `chapter_view`/`chapter_dwell`/`cta_click` keyed by chapter id only. Same blind spot as the funnel's missing PDP-vs-lander split.

## Fix options (decide when picked up)
1. **Stamp the hero `data-section` per variant** — e.g. `advertorial-hero` / `reasons-hero` / `beforeafter-hero` — so each variant's hero is a distinct chapter. Cleanest; changes event vocabulary going forward (historical rows stay generic).
2. **Add a lander-variant dimension** to the Chapter Performance aggregation (join `storefront_sessions.advertorial_page_id → advertorial_pages.variant`) and group chapters within variant. No storefront change; fixes history too.
3. Both — (2) for correct segmentation now + history, (1) so the raw event is self-describing.

Recommended: **(2)** (no client redeploy, fixes back-data), optionally **(1)** later.

## Related
Same un-segmented-by-variant root issue as the storefront funnel blending bare-PDP + lander engagement/conversion. If we build a per-variant sessions/funnel SDK, Chapter Performance should consume the same variant dimension.
