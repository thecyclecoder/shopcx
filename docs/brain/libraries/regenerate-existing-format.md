# `src/lib/ads/regenerate-existing-format.ts`

Surgical in-place edit of ONE placement format on an EXISTING ad ([[../tables/ad_campaigns]] row), threading the CEO's per-format review comment into the render prompt so the fix is APPLIED to the exact ad the CEO commented on — never a new whole-pack ad.

Phase 1 of [[../specs/ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad]].

**Why this exists** — the CEO left per-format feedback on Superfood Tabs `80853ef2` ("make the product bigger", "change the 'free tote' badge to 'Free Shipping with Subscribe and Save'", "change 'Clean, steady energy without jitters' to 'Say goodbye to bloating and cravings'"). The [[ad-review-feedback-router]] correctly dispatched an `ad-creative` job per commented format carrying `{ad_campaign_id, format, revise_reason}`, but the receiving lane ([[builder-worker]] `runAdCreativeJob`) ignored those fields and ran a normal FRESH whole-pack generation — the CEO's ad stayed untouched and TWO brand-new campaigns showed up instead. The CEO's exact observation: *"it's almost like she just made 2 new ads instead of editing the existing one."* This module is the surgical in-place path that fixes that.

## Exports

| Export | Purpose |
|---|---|
| `regenerateExistingFormat(admin, input, deps?)` | End-to-end helper: loads the campaign + finds the [[../tables/ad_videos]] row for `{campaign_id, format}`, reconstructs the [[creative-brief]] from the campaign's `product_id` + `angle_id`, calls [[creative-generate]] `generateCreative` with the format's `PLACEMENT_ASPECT` ratio + the CEO note threaded as `ceoReviseReason`, and **overwrites the same `ad_videos` row's `static_jpg_url` + `meta.storage_path` in place** (reusing the same `video_id.jpg` storage path — `upsert:true` so the previous bytes are replaced, no orphan file). NEVER inserts a new `ad_campaigns` row. Bumps `ad_campaigns.updated_at` so the CEO can see her note landed. Returns `{ok:true, adVideoId, storagePath, signedUrl, prompt}` or `{ok:false, reason}`. |
| `reconstructAngleFromRow(row)` | Pure — turn a persisted [[../tables/product_ad_angles]] row into the minimal `ScoredAngle` `buildCreativeBrief` reads (hook / leadBenefit / source / raw). Neutral acquisition/retention scores (this is an EDIT of an already-shipped creative, not a re-ranking). Exported so a unit test can pin the mapping in isolation. |
| `RegenerateExistingFormatDeps` | Dependency-injectable seams (`generate` / `upload` / `sign` / `buildBrief` / `loadPi`) — every seam falls back to the production impl when omitted, so a test can pin the branch decision + writes without hitting Nano Banana or Supabase Storage. |

## Guards (hard-required — this is the whole point)

1. **NEVER `.from('ad_campaigns').insert(...)`.** The fresh whole-pack path (runAdCreativeLoop → stockProduct → insertReadyCreative) is what created the two extra campaigns; the CEO's spec explicitly forbids it on a feedback edit. Test (a) in `regenerate-existing-format.test.ts` fails the whole run if the fake admin's insert counter is nonzero.
2. **Only the target format's `ad_videos` row is updated.** The lookup is `.eq('workspace_id',ws).eq('campaign_id',id).eq('format',fmt)` — a missing row returns `ok:false` with `reason:'no_ad_video_for_format'` (never insert a new one — the format isn't in this campaign's placement pack). Test (d) pins the no-insert-on-miss guard.
3. **Storage path is reused (`finals/{ws}/{video_id}.{ext}`).** Same `video_id` → the previous bytes are replaced in place (uploadBuffer uses `upsert:true`), so there's no orphan file to sweep and no stale sibling to leak.
4. **`meta` is merged, not overwritten.** The existing row may carry `archetype` / `generated_by` we want to preserve; the update patch is `{ ...existingMeta, storage_path }`.
5. **Empty CEO note is refused.** `ceoReviseReason.trim() === ""` returns `ok:false` with `reason:'empty_ceo_revise_reason'` — a whitespace-only comment can't drive a surgical edit.
6. **Unknown format is refused.** Anything not in [[creative-pack]] `PLACEMENT_ASPECT` returns `ok:false` with `reason:'unknown_format:<fmt>'` before any DB work.

## Callers

- **`runAdCreativeJob` in [[builder-worker]]** — the ONLY production caller. Detects `{ad_campaign_id, format, revise_reason}` on `job.instructions` (the shape [[ad-review-feedback-router]] `specForEntry('render-format')` builds), hands off, and returns — never falls through to `runAdCreativeLoop`. A normal (non-feedback) invocation keeps today's fresh whole-pack path unchanged, so the fresh-pack cadence cron ([[../inngest/ad-creative-cadence]]) is untouched.

## Wire

```
runAdCreativeJob (job.instructions = {ad_campaign_id, format, revise_reason, …})
  │
  ├─ regenerateExistingFormat(admin, {workspaceId, adCampaignId, format, ceoReviseReason})
  │    │
  │    ├─ .from('ad_campaigns').select('id, workspace_id, product_id, angle_id').eq('id', adCampaignId) → campaign
  │    ├─ .from('ad_videos').select('id, static_jpg_url, meta').eq('campaign_id', adCampaignId).eq('format', format) → video
  │    ├─ getProductIntelligence(admin, workspaceId, productId) → pi
  │    ├─ .from('product_ad_angles').select(...).eq('id', angle_id) → angleRow
  │    ├─ buildCreativeBrief(pi, reconstructAngleFromRow(angleRow)) → brief
  │    ├─ generateCreative(workspaceId, brief, {aspectRatio: PLACEMENT_ASPECT[format], ceoReviseReason}) → render
  │    │    │
  │    │    └─ buildPrompt threads the CEO_EDIT_HEADER clause at the top of the composed prompt
  │    ├─ uploadBuffer(`finals/${ws}/${adVideoId}.${ext}`, render.buffer, render.mimeType)   (upsert:true → in-place)
  │    ├─ signedUrl(storagePath) → url
  │    ├─ .from('ad_videos').update({static_jpg_url:url, meta:{…existingMeta, storage_path}, status:'ready'}).eq('id', adVideoId)
  │    └─ .from('ad_campaigns').update({updated_at:now}).eq('id', adCampaignId)              (bump so the CEO sees her note landed)
  │
  └─ agent_jobs.update({status:'completed', log_tail:{path:'feedback_in_place_regen', …}})
```

## Test coverage

`src/lib/ads/regenerate-existing-format.test.ts` — 6 pinned cases:
- (a) feedback-targeted regen updates the EXISTING `ad_videos` row for the named format AND NEVER inserts a new `ad_campaigns` row + the CEO note is threaded into `generateCreative` + the returned prompt carries `CEO_EDIT_HEADER`.
- (b) unknown format returns `ok:false`, zero writes.
- (c) empty CEO revise reason returns `ok:false`.
- (d) no matching `ad_videos` row → `ok:false` (never insert one).
- (e) `buildPrompt` threads `ceoReviseReason` as the `CEO_EDIT_HEADER` clause ABOVE the `HEADLINE` clause, and the exact CEO note appears verbatim.
- (f) `reconstructAngleFromRow` maps `hook_one_liner` + `lead_benefit_anchor` correctly and tolerates a null row.

## Ownership

- **Owner:** `growth` (Max) — inherits from the caller ([[builder-worker]] `runAdCreativeJob`, kind `ad-creative`).
- **Persona (box card):** Dahlia 🎨 — the render is authored on her lane; the CEO-review re-drive is her surgical edit path.
- **Kill switch:** inherits `dept:growth` via the [[control-tower/kill-switch-resolver]] ancestry walk — the same switch that stops fresh-pack generation stops the in-place edit path.

## Gotchas

- **This module does not touch copy.** The router routes copy-target comments (`copy-variation` / `canonical-copy`) to `ad-creative-copy-author`, not here. This module ONLY regenerates the image for the named format; the campaign's `product_ad_angles.metadata.copy_pack` + `ad_creative_copy_variants` are left untouched.
- **QA gate on the surgical edit is the trailing whole-ad re-QA the router already enqueues.** A `render-format` entry produces a targeted `ad-creative` job + the whole-ad `ad-creative-copy-qc` `mode:'final-re-qa'` job at the end of the packet (see [[ad-review-feedback-router]] `finalReQaSpec`). So the in-place edit still has to pass Max's whole-ad grade before Bianca reads the campaign — this module doesn't need its own QC pass.
- **`updated_at` bump is intentional.** The CEO's exact observation was that her ad's original `updated_at` never changed — her note had been ignored. Bumping it lets the CEO (or a support script) see, per campaign, that the CEO-review pass reached this row.

---

[[../README]] · [[../../CLAUDE]] · [[creative-generate]] · [[creative-agent]] · [[ad-review-feedback-router]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]]

## ⭐ The cold rail survives an in-place regen (CEO 2026-08-18)

The fresh-pack path strips the offer off a **cold** creative's IMAGE before rendering —
`brief.offer = imageOfferForAudience(angle, brief.offer)` in [[creative-agent]] `stockProduct`,
added after the 2026-07-17 run baked a discount into a cold static. This in-place regen rebuilds
its own brief (`buildBrief(pi, angle)`) and **never inherited that line**, so a CEO edit re-rendered
a cold ad WITH the offer.

**Ground truth 2026-08-18.** Campaign `c7fe4815` ("steaming mug pouch gut hook",
`audience_temperature='cold'`) came back from a feedback edit carrying
`Up to 34% off + free shipping (25% Subscribe & Save + up to 12% for 3+ units)` and
`$1.76/serving vs a $4-8 coffee/latte` baked into the pixels.

The rail keys off the **persisted `ad_campaigns.audience_temperature`**, not the reconstructed
angle: `reconstructAngleFromRow` hardcodes `source:'ad_angle'`, so `resolveAudienceTemperature`
can never classify a rebuilt angle as cold and `imageOfferForAudience` would pass the offer straight
through. The column records what the creative was actually authored for. Pinned by cases (e)/(e2)
in `regenerate-existing-format.test.ts` — cold strips, warm/hot keep.

### ✅ An edit REPLAYS the original prompt (CEO 2026-08-18, Phase 2)

The offer was one of **four** rails the fresh path applies that a rebuilt brief cannot carry. Rather
than re-deriving each one and hoping the list stays complete, an edit now **replays the original
per-placement prompt** — persisted at `ad_videos.meta.render.prompt` (Phase 4 render provenance) —
with the owner's change layered on top, and hands the ad's CURRENT image to the model as the FIRST
image so "reproduce this, change only X" is anchored to pixels rather than to a description of them.

`buildInPlaceEditPrompt(originalPrompt, reviseReason)` composes it behind the `IN_PLACE_EDIT_HEADER`
sentinel; `generateCreative` accepts it as `opts.overridePrompt` and skips `buildPrompt` while still
computing `expectedCopy` from the brief so the caller's garble QA is unchanged.

Because the original prompt already encodes the cold-offer treatment, the owner's `authorNotes`, the
composition-transfer/SOURCE STRUCTURE clause and the treatment steer, replaying it **preserves every
rail by construction** — including rails added later that this file has never heard of.

**Guards.**
- Gated on `prompt_truncated`: the persisted prompt is capped at write time, and replaying a string
  cut mid-sentence is worse than rebuilding. Truncated ⇒ fall back.
- Missing prompt (pre-Phase-4 rows) ⇒ fall back to the rebuild path, with the cold rail above still
  applied, so legacy creatives remain editable.

Pinned by cases (f)/(f2)/(f3) in `regenerate-existing-format.test.ts`: the original prompt is
replayed verbatim with the change appended and the current render passed as the anchor; a truncated
prompt is never replayed; a row with no persisted prompt still regenerates.

### Historical — the divergence this replaced

The offer was one of **four** rails the fresh path applies that this path does not. Compare:

| fresh pack (`stockProduct`) | in-place regen |
|---|---|
| `buildCreativeBrief(pi, angle, stories, { pureCompetitor, authorNotes })` | `buildBrief(pi, angle)` — no stories, no owner notes, no riff flag |
| `imageOfferForAudience` cold strip | ✅ fixed above |
| `planCompositionTransfer` → `compositionTransfer` + `designReferenceUrl` | not passed — the competitor imitation structure is lost |
| per-creative `treatment` steer | not passed |

So a feedback edit still re-renders a **generic** ad with the CEO note attached rather than editing
the creative that exists — which is why an imitation comes back not looking like its source. The
durable fix is to stop rebuilding a brief at all and reuse the ORIGINAL prompt, which is already
persisted per placement at `ad_videos.meta.render.prompt` (Phase 4 render provenance), applying the
CEO edit on top. That preserves every rail by construction instead of re-deriving them.
