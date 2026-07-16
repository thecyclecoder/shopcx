# `src/lib/ads/placement-publish.ts` — Route complete packs through the 3-bucket builder

Deterministic resolver for Bianca's 3-placement publish path ([[../specs/bianca-publishes-3-placement-multi-copy-via-placement-customization]] Phase 2). Given an `ad_publish_jobs` job's ready `ad_videos` siblings + its `headlines[]` / `primary_texts[]` copy pack, decides whether this creative can publish through the Phase-1 3-bucket [[meta-ads]] `createPlacementCreative` builder (portable, placement-customized, non-DCO) or must fall through to the legacy 2-bucket / single-image path unchanged.

Pure — no DB / no fetch / no Meta. [[../inngest/ad-tool]] calls this from the publish job's `load` step to route the publish; the single-image path is untouched for creatives without a full pack.

The predicate mirrors — but does not duplicate — Phase 3's `isCreativePackComplete` ([[creative-pack]]): Phase 3 is the AUTHORITATIVE gate the publish path will REFUSE on (author of a `missing_creative_pack` escalation); Phase 2 uses the same shape to ROUTE. When both wire up, the gate short-circuits before the resolver ever runs. See the north-star principle in [[../operational-rules.md]].

## Exports

| Export | Notes |
|---|---|
| `resolvePlacementPublish(input)` | Pure. Inspects `mediaKind`, the ready `ad_videos` rows for a campaign, and the job's copy pack; returns `{ ready: true, feed, story, rightColumn }` when all three placement statics AND ≥4 headlines + ≥4 primary texts are present, else `{ ready: false, reason }` naming the first missing piece. The ORDER of checks matters: media-kind first (video / mixed-kind creatives never take this path), then the three placement statics in [[creative-pack]] canonical order (feed → 9:16 → right-column), then the 4×4 copy pack. The first failure short-circuits so `reason` names the most-fundamental missing piece. |
| `PlacementPublishReady` | Resolved 3-bucket inputs — `feed 4:5` + (`stories_9x16` \| `reels_9x16`) 9:16 + `right_column_1x1` 1:1. Shape: `{ ready: true; feed; story; rightColumn }` where each is a subset `PlacementPublishAdVideo`. |
| `PlacementPublishReason` | Stable reasons the 3-bucket path can't run — grep-able, used as fall-through discriminators: `not_static` \| `missing_feed_4x5` \| `missing_9x16_sibling` \| `missing_right_column_1x1` \| `headlines_below_min` \| `primary_texts_below_min`. |
| `PlacementPublishDecision` | Union: `PlacementPublishReady` \| `{ ready: false; reason: PlacementPublishReason }`. |
| `PlacementPublishAdVideo` | Subset of an `ad_videos` row this resolver needs to route publishing: `{ id, format, media_kind, static_jpg_url?, meta? }`. |

## Caller

[[../inngest/ad-tool]] `adToolPublishToMeta` — loaded pack routing. Routes complete static campaigns (feed 4:5 + 9:16 sibling + right_column 1:1 + 4 headlines + 4 primary texts) to `createPlacementCreative` instead of `createDualAssetCreative` or the single-image path.

## Related

[[creative-pack-gate]] (Phase 3 refusal gate) · [[meta-ads]] (`createPlacementCreative`) · [[../lifecycles/ad-publish]]
