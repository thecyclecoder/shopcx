/**
 * Spec 1 (founder-directed 2026-07-16, "get it done"): Dahlia produces the FINISHED creative pack —
 * 4 headlines + 4 primary texts (same LF8/consumer-psychology) + 3 placement statics (feed 4:5,
 * stories/reels 9:16, right-column 1:1) with consistent CORE conversion psychology (only size/layout
 * varies). Plus the DB adjustment: ad_videos.format has no 1:1/right-column variant today — add it so a
 * creative can hold all 3 placement statics as format_variant_of_id siblings ("one ad = N rows").
 * Battle-tested 2026-07-16: creative 780957111743379 accepted a 3-image PLACEMENT creative + 4hl/4pt.
 * Owner=growth (Dahlia). Enhancements / Meta AI image-gen are explicitly OUT (deferred by CEO).
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "dahlia-produces-3-placement-multi-copy-creative-pack";
const PARENT =
  '[[../functions/growth]] — "Ad creative (Dahlia, under Max — beside Bianca)" mandate: Dahlia authors the finished creative a media buyer can publish. A finished ad = 4 headlines + 4 primary texts (same LF8 / consumer psychology) + 3 placement-sized statics (feed 4:5, stories/reels 9:16, right-column 1:1) with the SAME core conversion psychology (only size/layout varies). Platform builds ([[../functions/platform]]).';

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: "Dahlia produces the 3-placement + 4-headline + 4-primary-text creative pack (+ right-column format)",
      summary:
        "**Brain refs:** [[../tables/ad_videos]] (`format` · `format_variant_of_id` · `media_kind` · `static_jpg_url`) · [[../tables/product_ad_angles]] · [[../libraries/ad-meta-copy]] · [[../functions/growth]] (Dahlia)\n\nDahlia's output becomes the exact shape Bianca publishes (sibling spec [[bianca-publishes-3-placement-multi-copy-via-placement-customization]]). A finished creative carries **4 headline variations + 4 primary-text variations** (one LF8 driver / consumer-psychology core, varied hooks — NOT a temperature spread) AND **3 placement statics**: feed 4:5, stories/reels 9:16, right-column 1:1, all the SAME core conversion psychology (only colour/layout/crop varies, no dramatic shift). `ad_videos` already stores format siblings (`feed_4x5`, `stories_9x16`, `reels_9x16`) via `format_variant_of_id`, but has **no 1:1 / right-column format** — that's the DB adjustment. Battle-tested 2026-07-16 (creative `780957111743379`): Meta accepted a 3-image PLACEMENT creative + 4 titles + 4 bodies. Creative enhancements / Advantage+ AI image generation are explicitly OUT of scope (deferred by the CEO).",
      owner: "growth",
      parent: PARENT,
      parent_kind: "mandate",
      parent_ref: "growth#ad-creative-dahlia-under-max-beside-bianca",
      blocked_by: [],
      priority: "high",
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: null,
      why:
        "Today Dahlia produces a single static + a single copy set, but a fatigue-resistant, placement-optimized ad needs 3 correctly-sized statics (one per placement family) + copy variety Meta can rotate. The publisher can only assemble that if the DB can hold it — and `ad_videos.format` has no right-column/1:1 variant, so a right-column static has nowhere to live. Without this, Bianca's battle-tested 3-placement publish (the sibling spec) has no pack to draw from.",
      what:
        "(1) DB: add a right-column format to `ad_videos.format` (e.g. `right_column_1x1`) via migration, so one creative holds all 3 placement statics as `format_variant_of_id` siblings (canonical + variants). (2) Dahlia authoring: per creative, produce 4 headlines + 4 primary texts (one LF8 driver, varied hooks — stored where the publish path reads copy, [[../tables/product_ad_angles]] / the ad-copy source) AND 3 placement statics (feed 4:5, stories/reels 9:16, right-column 1:1) with the SAME core conversion psychology (only colour/layout/crop varies). (3) A deterministic completeness gate: a creative is not 'ready to publish' until it has all 3 placement statics + ≥4 headlines + ≥4 primary texts — surfaced so Bianca's publish gate can require it.",
    },
    [
      {
        position: 1,
        title: "Phase 1 — DB: right-column (1:1) format variant so a creative holds 3 placement statics",
        status: "planned",
        body:
          "Add the right-column format so the 3-placement pack (feed 4:5 + stories/reels 9:16 + right-column 1:1) can be stored as format_variant_of_id siblings. Today `format` is `reels_9x16 | feed_4x5 | stories_9x16` — no 1:1/right-column.",
        why:
          "`ad_videos.format` has no 1:1/right-column value, so a right-column static has no valid row — the pack can't be persisted, and the publisher (sibling spec) can't assemble a 3-placement creative. The self-referential `format_variant_of_id` sibling model already exists ('one ad = N rows'); this just adds the missing format.",
        what:
          "Migration `supabase/migrations/YYYYMMDDNNNNNN_add_right_column_static_format.sql` adds a right-column value (e.g. `right_column_1x1`) to the `ad_videos.format` allowed set (lowercase, matching the existing enum discipline). Update [[../tables/ad_videos]] brain page's `format` row + the 'one ad = N rows' note to include the right-column sibling. No backfill needed (new creatives populate it).",
        verification:
          "The migration applies cleanly; a static ad_videos row can be inserted with `format='right_column_1x1'` and `format_variant_of_id` pointing at a canonical row. `npx tsc --noEmit` clean. Brain ad_videos.md updated.",
      },
      {
        position: 2,
        title: "Phase 2 — Dahlia authors 4 headlines + 4 primary texts + 3 placement statics (consistent core psychology)",
        status: "planned",
        body:
          "Dahlia's creative output becomes the finished pack: 4 headline variations + 4 primary-text variations (one LF8 driver / psychology core, varied hooks — not a temperature spread) and 3 placement statics with the SAME core conversion psychology (only size/layout/crop varies).",
        why:
          "Copy variety lets Meta rotate 4 hooks per placement (fights early fatigue) and 3 correctly-sized statics win each placement's real estate — but ONLY if the psychology stays consistent across statics (a dramatic shift between statics breaks the crown signal). Dahlia is the author who holds the LF8 + consumer-psychology; she must emit the full pack, not one static + one copy.",
        what:
          "Extend Dahlia's creative authoring so each produced creative carries: 4 headlines + 4 primary texts (persisted to the ad-copy source the publish path reads — [[../tables/product_ad_angles]] / [[../libraries/ad-meta-copy]]), and 3 placement statics (feed 4:5, stories/reels 9:16, right-column 1:1) generated from ONE creative concept (same hook/visual psychology; only colour/layout/crop varies) stored as `format_variant_of_id` siblings with the correct `format`. The core psychology is shared across all 3 statics by construction (same concept → 3 renders), never 3 unrelated images.",
        verification:
          "vitest: a Dahlia-authored creative yields exactly 3 placement statics (feed_4x5 / stories_9x16 or reels_9x16 / right_column_1x1) as siblings + ≥4 headlines + ≥4 primary texts; the 3 statics share the creative concept id (same-psychology invariant). `npx vitest run` green.",
      },
      {
        position: 3,
        title: "Phase 3 — deterministic 'pack complete' gate Bianca's publish can require",
        status: "planned",
        body:
          "A creative is publish-ready only when the full pack exists. Surface a deterministic check so the sibling publish spec can refuse an incomplete pack instead of shipping a 1-image / 1-copy ad.",
        why:
          "Without a completeness gate, a half-authored creative (missing the right-column static or <4 copy) would publish as a degraded ad and silently lose the placement/fatigue benefit. The gate makes the pack contract explicit and machine-checked — the same supervisable-autonomy rail the publish gate uses.",
        what:
          "Add a pure predicate (e.g. `isCreativePackComplete(creative)`) that returns ready only when all 3 placement statics + ≥4 headlines + ≥4 primary texts are present, exported for the sibling publish gate to consult. Record the reason when incomplete so a not-ready creative is diagnosable (not a silent skip).",
        verification:
          "vitest: the predicate returns true for a full pack and false (with a reason) for each missing piece (no right-column static / <4 headlines / <4 primary texts). `npx tsc --noEmit` clean.",
      },
    ],
  );
  console.log("Dahlia pack spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
