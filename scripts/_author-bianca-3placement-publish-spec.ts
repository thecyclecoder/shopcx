/**
 * Spec 2 (founder-directed 2026-07-16, "get it done"): Bianca actually UPLOADS ads using the
 * battle-tested 3-placement + multi-copy method. Extend the existing createDualAssetCreative PLACEMENT
 * shape from 2 → 3 image buckets (feed 4:5, stories/reels 9:16, right-column 1:1) carrying 4 headline
 * + 4 primary-text variations, and wire Bianca's publish path to build it from Dahlia's pack.
 * Battle-tested 2026-07-16 (creative 780957111743379, ad 120252471398980184, PAUSED) — Meta accepted
 * it and it renders across feed / IG story / FB story / IG standard / right column, NOT DCO (portable).
 * blocked_by the Dahlia pack spec (the pack must exist to publish). Owner=growth (Bianca).
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "bianca-publishes-3-placement-multi-copy-via-placement-customization";
const PARENT =
  '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: Bianca publishes the finished creative pack into her test cohort as ONE portable, placement-optimized ad (3 placement statics + 4 headlines + 4 primary texts), so winners can be duplicated into scaling campaigns. Platform builds ([[../functions/platform]]).';

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: "Bianca publishes 3-placement + 4-headline + 4-primary-text ads (battle-tested PLACEMENT method, portable)",
      summary:
        "**Brain refs:** [[../libraries/meta-ads]] (`createDualAssetCreative` — the PLACEMENT/`asset_customization_rules` shape) · [[../inngest/ad-tool]] (the publisher that consumes `ad_publish_jobs`) · [[../tables/ad_publish_jobs]] (`headlines` · `primary_texts`) · [[../tables/ad_videos]] (`format_variant_of_id` siblings) · [[../libraries/media-buyer-publish-gate]]\n\nConsumes the pack from sibling spec [[dahlia-produces-3-placement-multi-copy-creative-pack]]. **Battle-tested 2026-07-16** — creative `780957111743379` / ad `120252471398980184` (PAUSED in the Amazing Coffee advertorial adset) proved Meta accepts a single **portable** (NOT Dynamic Creative) ad with 3 placement images (feed 4:5, stories/reels 9:16, right-column 1:1) + 4 headlines + 4 primary texts, rendering across feed / IG story / FB story / IG standard / right column. The exact working shape: `object_story_spec:{page_id,instagram_user_id}` + `asset_feed_spec:{ ad_formats:['AUTOMATIC_FORMAT'], optimization_type:'PLACEMENT', images:[3 hashes each adlabel'd to its placement + a default], titles:[4, each adlabel'd to ALL placements], bodies:[4, each adlabel'd to ALL placements], link_urls:[{website_url,display_url,adlabels:all}], call_to_action_types, asset_customization_rules:[feed→p1, stories→p2, right_hand_column/search→p3, default→p4] }` + `degrees_of_freedom_spec.creative_features_spec.text_optimizations=OPT_OUT`. Creative enhancements / Advantage+ AI image-gen are OUT of scope (deferred by the CEO).",
      owner: "growth",
      parent: PARENT,
      parent_kind: "mandate",
      parent_ref: "growth#media-buyer-bianca-under-max",
      blocked_by: ["dahlia-produces-3-placement-multi-copy-creative-pack"],
      priority: "high",
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: null,
      related_spec: "dahlia-produces-3-placement-multi-copy-creative-pack",
      why:
        "Bianca today publishes a single-image ad with a single copy set. The founder battle-tested (2026-07-16) that Meta accepts a portable 3-placement + 4-headline + 4-primary-text ad and it renders across every placement — this is the finished-ad shape we want in-market. It's only real value once Bianca's publisher actually assembles + uploads it from Dahlia's pack; a proven shape that no code path uses ships nothing.",
      what:
        "(1) Extend the creative builder to the battle-tested 3-bucket PLACEMENT shape: generalize `createDualAssetCreative` (or add `createPlacementCreative`) from 2 → 3 image placements (feed 4:5, stories/reels 9:16, right-column 1:1) carrying N headlines + N primary texts (each adlabel'd to all placements so Meta rotates the 4 hooks per placement), `optimization_type:'PLACEMENT'`, `asset_customization_rules` for feed / stories / right_hand_column+search / default, `text_optimizations` OPT_OUT — the EXACT payload proven by creative 780957111743379. Keep it a regular (non-DCO) creative so it stays portable into scaling campaigns. (2) Wire Bianca's publish path ([[../inngest/ad-tool]] consuming [[../tables/ad_publish_jobs]]): upload the 3 placement statics (from the pack's `format_variant_of_id` siblings) → 3 image hashes, pass the 4 headlines + 4 primary texts, and publish via the new builder. (3) Publish gate: refuse to publish a creative whose pack is incomplete (consult the Phase-3 predicate from the Dahlia spec) — escalate rather than ship a degraded 1-image ad.",
    },
    [
      {
        position: 1,
        title: "Phase 1 — 3-bucket PLACEMENT creative builder (the battle-tested payload)",
        status: "planned",
        body:
          "Generalize the existing 2-bucket createDualAssetCreative PLACEMENT shape to 3 buckets (feed 4:5, stories/reels 9:16, right-column 1:1) carrying N titles + N bodies. Mirror the exact payload proven by creative 780957111743379 — do not re-invent it.",
        why:
          "createDualAssetCreative already does portable (non-DCO) placement customization for 2 buckets via `asset_customization_rules` + `optimization_type:'PLACEMENT'`; the battle-test proved the 3-bucket + 4/4-copy extension is accepted by Meta and renders across all placements including right column. A faithful extension (not a rewrite) is the lowest-risk path.",
        what:
          "Add/extend a builder in [[../libraries/meta-ads]] that takes 3 image hashes (feed/stories/rightcol) + headlines[] + primaryTexts[] and emits: `object_story_spec:{page_id,instagram_user_id}`; `asset_feed_spec` with `ad_formats:['AUTOMATIC_FORMAT']`, `optimization_type:'PLACEMENT'`, 3 adlabel'd images (feed image also carries the default label), titles/bodies each adlabel'd to ALL placements, `link_urls:[{website_url,display_url,adlabels:all}]`, `call_to_action_types`, and `asset_customization_rules` [feed→p1 (feed/profile_feed/marketplace + IG stream/explore/profile), stories→p2 (story/facebook_reels/video_feeds + IG story/reels), right-column→p3 (facebook right_hand_column + search), default→p4 {}]; `degrees_of_freedom_spec.creative_features_spec.text_optimizations=OPT_OUT`. Update meta-ads.md with the 3-bucket shape + the 'portable, not DCO' note.",
        verification:
          "vitest: the builder emits `optimization_type:'PLACEMENT'` (never a DCO `is_dynamic_creative` / SINGLE_* format), 3 images with correct adlabels, 4 titles + 4 bodies each labeled to all placements, and 4 customization rules incl. a `right_hand_column` rule. `npx tsc --noEmit` clean.",
      },
      {
        position: 2,
        title: "Phase 2 — wire Bianca's publish path to upload the pack + publish the 3-placement ad",
        status: "planned",
        body:
          "Bianca's publisher assembles the ad from Dahlia's pack: upload the 3 placement statics → 3 hashes, pass 4 headlines + 4 primary texts, publish the placement-customized creative into the test cohort adset (paused/active per the existing gate).",
        why:
          "The builder is inert until the publish path feeds it the pack. The publisher already consumes `ad_publish_jobs` (headlines[]/primary_texts[]) and uploads media; it must now source the 3 placement statics from the creative's `format_variant_of_id` siblings and call the 3-bucket builder instead of the single-image path.",
        what:
          "In [[../inngest/ad-tool]] (the ad_publish_jobs consumer), for a static placement creative: resolve the 3 placement statics (feed_4x5 / stories_9x16|reels_9x16 / right_column_1x1) from [[../tables/ad_videos]] siblings, upload each via `uploadAdImage` → hash, and call the Phase-1 builder with the 3 hashes + the job's headlines[] + primary_texts[]. Preserve the existing budget/publish gate + PAUSED-by-default behaviour. Record the placement creative id on the publish job.",
        verification:
          "vitest / integration: a publish job for a complete pack resolves 3 placement hashes and calls the 3-bucket builder with 4 headlines + 4 primary texts; the single-image path is untouched for creatives without a full pack. `npm run test:media-buyer-agent` (or the ad-tool test) green.",
      },
      {
        position: 3,
        title: "Phase 3 — publish gate requires a complete pack (no degraded 1-image ship)",
        status: "planned",
        body:
          "Refuse to publish a placement ad whose pack is incomplete — consult the Dahlia spec's completeness predicate and escalate instead of silently shipping a 1-image / <4-copy ad.",
        why:
          "If the pack is missing the right-column static or <4 copy, publishing anyway loses the placement + fatigue benefit and produces an inconsistent in-market ad. The gate makes the pack contract enforceable at the publish boundary — the same supervisable-autonomy rail as the existing media-buyer publish gate.",
        what:
          "Extend [[../libraries/media-buyer-publish-gate]] (or the publisher's pre-flight) to require `isCreativePackComplete` before a placement publish; a missing pack refuses + escalates (a `missing_creative_pack` reason) rather than falling back to a degraded single-image ad. Add a verification proving an incomplete pack is refused and a complete one passes.",
        verification:
          "vitest: the gate refuses a publish whose creative lacks the 3 placement statics or <4 headlines/primary texts (with a diagnosable reason) and allows a complete pack. `npx vitest run` green.",
      },
    ],
  );
  console.log("Bianca publish spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
