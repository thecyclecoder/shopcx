/**
 * creative-pack-gate — Bianca's publish-boundary refusal
 * (`bianca-publishes-3-placement-multi-copy-via-placement-customization` Phase 3).
 *
 * The publisher's pre-flight rail. Where Phase 2's `[[placement-publish]]`
 * `resolvePlacementPublish` ROUTES a complete pack through the 3-bucket builder
 * and lets an incomplete one fall through to the legacy 2-bucket / single-image
 * path, Phase 3 REFUSES that fall-through for a static campaign Dahlia authored:
 * shipping a 1-image / <4-copy ad from an authored-but-incomplete pack loses the
 * placement + fatigue benefit and produces an inconsistent in-market ad.
 *
 * Pure predicate (no DB / no fetch / no Meta) — the caller in `[[../inngest/ad-tool]]`
 * loads the campaign's `ad_videos` + angle metadata and asks the gate. The refuse
 * verdict names ONE of `[[creative-pack]]`'s stable `CreativePackIncompleteReason`
 * values so downstream escalations / director_activity rows can branch on it.
 *
 * This is the media-buyer publish-gate's north-star analog: hit a rail (the
 * pack contract) = ESCALATE, don't degrade. See CLAUDE.md § North star.
 */
import {
  isCreativePackComplete,
  type CreativePackReadiness,
  type CreativePackSnapshot,
} from "@/lib/ads/creative-pack";

/** Sentinel the caller writes to `ad_publish_jobs.publish_status` + escalates on. */
export const MISSING_CREATIVE_PACK_REASON = "missing_creative_pack" as const;

/** Skip reasons — the pack contract only applies to Dahlia-authored static packs. */
export type CreativePackGateSkipReason =
  | "not_static" // video / mixed-kind creatives; pack contract doesn't apply.
  | "no_dahlia_pack"; // no `feed_4x5` canonical row on the campaign — legacy studio-authored ad.

export type CreativePackGateVerdict =
  | { allowed: true; skipped?: CreativePackGateSkipReason }
  | {
      allowed: false;
      /** Machine-readable — every refusal carries this exact string on the escalation. */
      reason: typeof MISSING_CREATIVE_PACK_REASON;
      /** One of the seven `CreativePackIncompleteReason` values — routes escalation branching. */
      packReason: Exclude<CreativePackReadiness, { ready: true }>["reason"];
      /** Human-readable single line from `isCreativePackComplete` (surfaced in the escalation body). */
      detail: string;
    };

/** What the gate inspects for one publish job. */
export interface CreativePackGateInput {
  /** From the loaded publish job's anchor `ad_videos.media_kind`. */
  mediaKind: string;
  /** The `[[creative-pack]]` snapshot the caller already loaded for the campaign. */
  snapshot: CreativePackSnapshot;
}

/**
 * evaluateCreativePackGate — pure. The publisher's pre-flight decision:
 *
 *  - `mediaKind !== 'static'` → allow with `skipped:'not_static'` (video ads don't
 *    ride the Dahlia placement pack contract; the video publish path is untouched).
 *  - No `feed_4x5` canonical row on the campaign → allow with
 *    `skipped:'no_dahlia_pack'` (legacy studio-authored campaigns bypass the gate;
 *    the single-image / dual-asset paths keep running as before).
 *  - Otherwise → run `isCreativePackComplete(snapshot)`. `ready:true` allows;
 *    `ready:false` REFUSES with `reason:'missing_creative_pack'` + the pack's
 *    specific `packReason` (`canonical_missing` / `canonical_not_ready` /
 *    `missing_9x16_sibling` / `missing_right_column_1x1_sibling` / `copy_pack_missing`
 *    / `headlines_below_min` / `primary_texts_below_min`) so the escalation can
 *    surface what to fix rather than a bare "publish refused".
 *
 * Refuse ORDER matches the pack contract's own short-circuit — the first missing
 * piece is named.
 */
export function evaluateCreativePackGate(input: CreativePackGateInput): CreativePackGateVerdict {
  if (input.mediaKind !== "static") return { allowed: true, skipped: "not_static" };

  // A Dahlia-authored pack always has a canonical `feed_4x5` row with
  // `format_variant_of_id IS NULL` on the campaign — via
  // `[[creative-pack]]` `planCreativePackInserts`. When no such row exists, the
  // campaign is a legacy studio publish that never went through the pack
  // authoring path; the gate doesn't apply.
  const dahliaAuthored = input.snapshot.adVideos.some(
    (r) => r.format === "feed_4x5" && r.format_variant_of_id === null,
  );
  if (!dahliaAuthored) return { allowed: true, skipped: "no_dahlia_pack" };

  const verdict = isCreativePackComplete(input.snapshot);
  if (verdict.ready) return { allowed: true };
  return {
    allowed: false,
    reason: MISSING_CREATIVE_PACK_REASON,
    packReason: verdict.reason,
    detail: verdict.detail,
  };
}

/**
 * Diagnosis string surfaced on the CEO escalation body and the growth
 * `director_activity` row. Names WHAT is missing and WHY that's fatal (a 1-image
 * ad loses the whole point of the placement + fatigue benefit), so a human can
 * fix it (re-render Dahlia's pack / re-run copy) rather than shrug at a boolean.
 */
export function missingCreativePackDiagnosis(args: {
  packReason: Exclude<CreativePackReadiness, { ready: true }>["reason"];
  detail: string;
  campaignId: string;
}): string {
  return (
    `Bianca publish REFUSED: creative pack for campaign ${args.campaignId} is incomplete ` +
    `(${args.packReason}). ${args.detail}. Shipping a 1-image / <4-copy ad loses the ` +
    `3-placement + fatigue benefit and produces an inconsistent in-market ad. Publishing ` +
    `NOTHING to Meta — re-run Dahlia's creative pack (3 placement statics + 4 headlines + ` +
    `4 primary texts) or promote the campaign manually. Your call.`
  );
}
