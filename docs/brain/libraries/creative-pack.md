# `src/lib/ads/creative-pack.ts`

The shape of a finished Dahlia creative pack — a complete, publish-ready ad Bianca can send to Meta. A finished pack carries **three placement-sized statics** (feed 4:5 canonical + stories/reels 9:16 + right-column 1:1 sibling, all expressing the same conversion psychology via `format_variant_of_id` linking) and **four headline variations + four primary-text variations** (one LF8 driver core, varied hooks — Meta rotates them per placement). Pure module — no DB, no LLM, no fetch. Verified by `src/lib/ads/creative-pack.test.ts` (phases 2–3 of [[../specs/dahlia-produces-3-placement-multi-copy-creative-pack]]).

## Key types

**`PlacementFormat = "feed_4x5" | "stories_9x16" | "reels_9x16" | "right_column_1x1"`** — the four placement families Meta rotates. Feed 4:5 is the canonical anchor (Meta's default); stories/reels share 9:16; right-column is the 1:1 square added by Phase 1 migration ([[../tables/ad_videos]] `format`).

**`PLACEMENT_ASPECT: Record<PlacementFormat, AspectRatio>`** — maps each format to its aspect ratio (`feed_4x5 → "4:5"`, `stories_9x16 | reels_9x16 → "9:16"`, `right_column_1x1 → "1:1"`). Used by [[creative-generate]] `generateCreativeBody` to render each placement from the same concept at the correct size.

**`CREATIVE_PACK_MIN = { placementStatics: 3, headlines: 4, primaryTexts: 4 }`** — minimum sizes for a "publish-ready" pack. `isCreativePackComplete` gates on these; [[creative-agent]] `readyStatusForAngle` consults `CREATIVE_PACK_MIN.headlines/primaryTexts` when deciding if a creative is ready for Bianca.

## Core functions

### `placementPackPlan(): PlacementPackPlan`

Returns the deterministic 3-placement recipe every Dahlia creative must follow. The canonical is always feed 4:5; the siblings are stories/reels 9:16 (for stories + reels placements) and right-column 1:1 (for right-column placement). The three statics share one concept by construction — only aspect ratio varies.

```ts
const plan = placementPackPlan();
// ⇒ { 
//   canonical: { format: 'feed_4x5', aspectRatio: '4:5' },
//   siblings: [
//     { format: 'stories_9x16', aspectRatio: '9:16' },
//     { format: 'right_column_1x1', aspectRatio: '1:1' }
//   ]
// }
```

### `buildMetaCopyPack(brief: CreativeBrief): MetaCopyPack`

Produces a deterministic 4-headline + 4-primary-text pack from one creative brief. Reuses [[creative-brief]] `buildMetaCopy` for the canonical first pair (so the psychology core matches the generated image), then rotates the same grounded fields (supporting benefits, proof stack, offer) into three more variations. Never fabricates copy — fills to 4 only from real brief material; when a slot has nothing new, it repeats the last real variant (still valid + truthful) so the pack shape holds without inventing.

All strings are capped to Meta's hard limits ([[ad-tool-config]] `META_CAPS`): headline ≤40 chars, primary text ≤125 chars.

```ts
interface MetaCopyPack {
  headlines: string[];    // exactly 4 (one psychology driver + 3 hooks)
  primaryTexts: string[]; // exactly 4 (proofs, offer, benefit rotations)
  description: string;    // ≤30 chars (offer treatment)
}
```

### `planCreativePackInserts(input: CreativePackInsertsInput): CreativePackInsertsPlan`

Pure planner — turns a rendered 3-placement pack into the exact DB writes [[creative-agent]] will execute. Emits one canonical `ad_videos` insert body (feed 4:5) + two sibling bodies (stories_9x16 + right_column_1x1, each with `format_variant_of_id` left unset — the caller stamps it with the canonical row's `id` after that insert returns, expressing the same-psychology invariant). Also includes the 4×4 copy pack shaped for the angle's `metadata.copy_pack` JSONB.

Enforces the pack shape invariant at authoring time — throws when:
- Canonical is not feed_4x5
- Fewer than 2 siblings
- Missing 9:16 coverage or right-column coverage
- Fewer than 4 headlines or primary texts

This throws so Phase 3's `isCreativePackComplete` can be a **re-check on already-persisted rows** (catching corruptions/races) rather than a first-line validator.

```ts
const plan = planCreativePackInserts({
  workspaceId,
  campaignId,
  canonicalRender: { format: 'feed_4x5', buffer, mimeType },
  siblingRenders: [
    { format: 'stories_9x16', buffer, mimeType },
    { format: 'right_column_1x1', buffer, mimeType }
  ],
  copyPack: { headlines: [...4], primaryTexts: [...4], description },
  archetype: 'testimonial',
  generatedBy: 'ad-creative-agent'
});
// ⇒ { canonical, siblings: [2 rows], angleMetadataCopyPack }
// siblings[].format_variant_of_id is null until the caller stamps it
```

### `isCreativePackComplete(snap: CreativePackSnapshot): CreativePackReadiness`

Phase 3 — the deterministic publish-time gate. Returns `{ ready: true }` when the campaign carries all 3 placement statics (canonical feed_4x5 + 9:16 sibling + right_column_1x1 sibling, all `media_kind='static'` AND `status='ready'`) AND its angle's `metadata.copy_pack` holds ≥4 headlines + ≥4 primary texts. Otherwise returns `{ ready: false, reason, detail }` with one of seven stable `CreativePackIncompleteReason` values so Bianca's publish gate can branch on the machine-readable reason (never free-text).

The order of checks matters — canonical first, then each sibling by placement, then the copy pack. The first failure short-circuits, so `detail` names only the most-fundamental defect.

```ts
interface CreativePackSnapshot {
  adVideos: PackAdVideoLike[];    // all ad_videos rows for the campaign
  canonicalId: string | null;     // the canonical row's id (or null if missing)
  angleMetadata: PackAngleMetadataLike | null; // the angle's metadata JSONB
}

// Returns one of:
// { ready: true }
// { ready: false, reason: 'canonical_missing', detail: '...' }
// { ready: false, reason: 'canonical_not_ready', detail: '...' }
// { ready: false, reason: 'missing_9x16_sibling', detail: '...' }
// { ready: false, reason: 'missing_right_column_1x1_sibling', detail: '...' }
// { ready: false, reason: 'copy_pack_missing', detail: '...' }
// { ready: false, reason: 'headlines_below_min', detail: '...' }
// { ready: false, reason: 'primary_texts_below_min', detail: '...' }
```

Reason strings are stable (grep-able) so downstream logs / director-activity rows can categorize a not-ready creative. Used by [[media-buyer-agent]] `publishToMeta` — it gates the actual Meta API call on `isCreativePackComplete({ adVideos, canonicalId, angleMetadata }).ready === true`.

## Callers

- **[[creative-agent]]** `stockProduct` renders the 3 placements from one brief via [[creative-generate]], calls `buildMetaCopyPack`, and uses `planCreativePackInserts` to structure the DB inserts. `insertReadyCreative` stamps `format_variant_of_id` on siblings after the canonical ad_videos insert returns.
- **[[media-buyer-agent]]** `publishToMeta` consults `isCreativePackComplete` before sending to Meta — a half-authored or corrupted pack is rejected at publish time with a reason string so Bianca can diagnose why.

## Gotchas

- **Same-psychology invariant:** The 3 statics are SIBLINGS linked via `format_variant_of_id`, never independent rows. A canonical row has `format_variant_of_id IS NULL`; both siblings point back at the canonical row's `id`. This is enforced by `planCreativePackInserts` at authoring time and re-checked by `isCreativePackComplete` at publish time.
- **Copy pack lives on the angle:** The 4×4 headlines + primary texts are persisted on `product_ad_angles.metadata.copy_pack` (backward-compatible JSONB, no schema change), not on a new column. The [[creative-agent]] `insertReadyCreative` stamps this via `planCreativePackInserts.angleMetadataCopyPack`.
- **Aspects matter:** Each placement must be rendered at its REAL aspect ratio (feed 4:5, stories/reels 9:16, right-column 1:1). Rendering a 4:5 image at 1:1 or vice versa breaks the visual psychology; [[creative-generate]] uses `PLACEMENT_ASPECT` to send the correct aspect to Nano Banana.
- **Never reels_9x16 without stories_9x16 equivalence:** Reels and stories both accept 9:16 statics. The code treats `stories_9x16` and `reels_9x16` as interchangeable 9:16 coverage — a pack with reels_9x16 satisfies the "needs a 9:16 sibling" requirement. But one pack renders 3 statics from one concept, so it will have exactly one of `stories_9x16` or `reels_9x16`, never both.

---

[[../README]] · [[../lifecycles/ad-creative]] · [[creative-agent]] · [[creative-generate]] · [[creative-brief]] · [[../tables/ad_videos]]
