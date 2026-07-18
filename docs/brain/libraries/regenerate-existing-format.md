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
