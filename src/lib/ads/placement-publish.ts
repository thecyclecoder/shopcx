/**
 * placement-publish — deterministic resolver for Bianca's 3-placement publish path
 * (`bianca-publishes-3-placement-multi-copy-via-placement-customization` Phase 2).
 *
 * Given an `ad_publish_jobs` job's ready `ad_videos` siblings + its `headlines[]` /
 * `primary_texts[]` copy pack, decides whether this creative can publish through the
 * Phase-1 3-bucket [[../meta-ads]] `createPlacementCreative` builder (portable,
 * placement-customized, non-DCO) or must fall through to the legacy 2-bucket /
 * single-image path unchanged.
 *
 * Pure — no DB / no fetch / no Meta. `[[../inngest/ad-tool]]` calls this from the
 * publish job's `load` step to route the publish; the `single-image path is
 * untouched for creatives without a full pack` (Phase 2 verification).
 *
 * The predicate mirrors — but does not duplicate — Phase 3's
 * `isCreativePackComplete` (`[[creative-pack]]`): Phase 3 is the AUTHORITATIVE
 * gate the publish path will REFUSE on (author of a `missing_creative_pack`
 * escalation); Phase 2 uses the same shape to ROUTE. When both wire up, the
 * gate short-circuits before the resolver ever runs.
 */
import { CREATIVE_PACK_MIN } from "@/lib/ads/creative-pack";

/** Subset of an `ad_videos` row this resolver needs to route publishing. */
export interface PlacementPublishAdVideo {
  id: string;
  format: string;
  media_kind: string;
  static_jpg_url?: string | null;
  meta?: { storage_path?: string | null } | null;
}

/** Resolved 3-bucket inputs — `feed 4:5` + (`stories_9x16` | `reels_9x16`) 9:16 + `right_column_1x1` 1:1. */
export interface PlacementPublishReady {
  ready: true;
  feed: PlacementPublishAdVideo;
  story: PlacementPublishAdVideo;
  rightColumn: PlacementPublishAdVideo;
}

/** Stable reasons the 3-bucket path can't run — grep-able, used as fall-through discriminators. */
export type PlacementPublishReason =
  | "not_static"
  | "missing_feed_4x5"
  | "missing_9x16_sibling"
  | "missing_right_column_1x1"
  | "headlines_below_min"
  | "primary_texts_below_min";

export type PlacementPublishDecision =
  | PlacementPublishReady
  | { ready: false; reason: PlacementPublishReason };

/**
 * resolvePlacementPublish — pure. Inspects `mediaKind`, the ready `ad_videos` rows
 * for a campaign, and the job's copy pack; returns `{ ready: true, feed, story,
 * rightColumn }` when all three placement statics AND ≥4 headlines + ≥4 primary
 * texts are present, else `{ ready: false, reason }` naming the first missing
 * piece.
 *
 * The ORDER of checks matters: media-kind first (video / mixed-kind creatives never
 * take this path), then the three placement statics in `[[creative-pack]]`
 * canonical order (feed → 9:16 → right-column), then the 4×4 copy pack. The first
 * failure short-circuits so `reason` names the most-fundamental missing piece.
 */
export function resolvePlacementPublish(input: {
  mediaKind: string;
  headlines: readonly string[];
  primaryTexts: readonly string[];
  readyAdVideos: readonly PlacementPublishAdVideo[];
}): PlacementPublishDecision {
  if (input.mediaKind !== "static") return { ready: false, reason: "not_static" };

  const statics = input.readyAdVideos.filter((v) => v.media_kind === "static");
  const feed = statics.find((v) => v.format === "feed_4x5");
  const story = statics.find((v) => v.format === "stories_9x16" || v.format === "reels_9x16");
  const rightColumn = statics.find((v) => v.format === "right_column_1x1");

  if (!feed) return { ready: false, reason: "missing_feed_4x5" };
  if (!story) return { ready: false, reason: "missing_9x16_sibling" };
  if (!rightColumn) return { ready: false, reason: "missing_right_column_1x1" };

  const nonEmpty = (arr: readonly string[]) => arr.filter((s) => (s ?? "").trim().length > 0).length;
  if (nonEmpty(input.headlines) < CREATIVE_PACK_MIN.headlines) return { ready: false, reason: "headlines_below_min" };
  if (nonEmpty(input.primaryTexts) < CREATIVE_PACK_MIN.primaryTexts) return { ready: false, reason: "primary_texts_below_min" };

  return { ready: true, feed, story, rightColumn };
}
