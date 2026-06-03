# inngest/ad-tool

Ad tool — async generation pipeline (Gemini Veo/Nano Banana Pro/Lyria + Higgsfield Soul/DoP + Whisper + Remotion). One function per stage; every piece persists to the creative library ([[../tables/ad_segments]]).

**File:** `src/lib/inngest/ad-tool.ts` · Registered in `src/app/api/inngest/route.ts` via `adToolFunctions`. See [[../libraries/gemini]], [[../libraries/ad-segments]], [[../integrations/higgsfield]], [[../libraries/ad-render]].

## Functions

All share `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]` so a single workspace can't monopolize Higgsfield rate limits.

### `ad-tool-face-requested`
- **Trigger:** event `ad-tool/face-requested` (`{ workspace_id, candidate_id, gender, age_range, health_level, ethnicity, context?, variant? }`) · **Retries:** 2
- Generates ONE avatar face: `buildAvatarPortraitPrompt` → `generateSoulPortrait` + poll → uploads to the library path → flips `ad_avatar_candidates` from `generating` → `available` (or `failed` + `error`). **This is why face gen is async** — image gen exceeds the Vercel function budget, so `POST /api/ads/avatars/candidates` inserts `generating` rows + fires N of these events and returns instantly; the UI polls the rows.

### `ad-tool-hero-requested`
- **Trigger:** event `ad-tool/hero-requested` · **Retries:** 2
- Loads campaign + avatar **face** (`reference_image_urls[0]`) + product isolated image → `generateNanoBananaProCombine([face, product])` (Gemini, 9:16, synchronous — identity-locked, sharp packaging text) → uploads hero → writes `ad_campaigns.hero_image_url` → emits `ad-tool/hero-completed`. Fails the campaign if the avatar has no face or the product has no isolated image. (Replaced Seedream/Soul combine.)

### `ad-tool-audio-requested`
- **Trigger:** event `ad-tool/audio-requested` · **Retries:** 2
- Legacy TTS path (`generateTtsAudio` → `ad_campaigns.audio_url`). **Vestigial in the Veo stack** — the VO now comes from the talking-head Veo clips' native audio, not TTS. Kept as a fallback; not on the critical path.

### `ad-tool-talking-head-requested` (Veo 3.1 Fast, multi-segment, persisted)
- **Trigger:** event `ad-tool/talking-head-requested` · **Retries:** 1
- Requires `hero_image_url`. `splitScriptIntoSegments` → ~8s beats; for each: `generateVeoVideo` (Veo 3.1 Fast, image-to-video from the hero, native audio = VO spine), Whisper sets the trim, persists an [[../tables/ad_segments]] row (`kind=talking_head`, its `script_text` + `transcript_json` + `trim_sec`). Sequential (Veo Fast daily cap). Emits `ad-tool/talking-head-completed`.

### `ad-tool-broll-requested`
- **Trigger:** event `ad-tool/broll-requested` · **Retries:** 2
- Pulls up to 3 `product_media` sources (lifestyle-first; `slot != 'hero'`), picks vibe-eligible motions, `generateDopVideo` each → persists an [[../tables/ad_segments]] row (`kind=broll`). Emits `ad-tool/broll-completed`.

### `ad-tool-render-requested`
- **Trigger:** event `ad-tool/render-requested` · **Retries:** 1
- Sets campaign `status='rendering'`. **`assemble` step:** `loadActiveSegments` (talking/broll/music) → generates a Lyria music bed if missing (persists `kind=music`) → `buildComposition` + `saveComposition` (`ad_campaigns.composition`) → resolves signed URLs → `buildVoCaptions` (per-segment Whisper proofread vs script, numbers + `%` preserved). Then renders **all 4 formats**: video via `renderVoSpineVideo` (canonical `ExampleAd` composition — VO spine + muted/ASMR b-roll + Lyria bed + captions), static via `renderAdFormat` (`AdStatic`). One `ad_videos` row per format (siblings via `format_variant_of_id`).

### `ad-tool-segment-regenerate` (the re-launch refresh)
- **Trigger:** event `ad-tool/segment-regenerate` (`{ workspace_id, campaign_id, seq, new_script }`) · **Retries:** 1
- `regenerateTalkingSegment` (deactivate the active beat at `seq`, insert `version+1` with the new script) → `generateVeoVideo` from the hero → Whisper trim → `completeSegment` → fires `ad-tool/render-requested` to re-stitch. See [[../recipes/ad-relaunch-refresh]]. Triggered by `POST /api/ads/campaigns/{id}/segments/regenerate`.

## Downstream events sent

`ad-tool/hero-completed` · `ad-tool/audio-completed` · `ad-tool/talking-head-completed` · `ad-tool/broll-completed` · `ad-tool/render-requested` (from segment-regenerate)

## Tables written

`ad_campaigns` (hero_image_url, audio_url, **composition**, status), `ad_segments` (talking/broll/music pieces — the creative library), `ad_videos` (one row per format), `ad_jobs` (every Higgsfield call, via the client wrapper).

## Tables read (not written)

`ad_avatars`, `product_variants`, `products`, `product_media`, `product_ad_angles`, `product_ingredients`, `workspaces` (`ad_tool_settings`, `gemini_api_key_encrypted`).

---

[[../README]] · [[../integrations/inngest]] · [[../integrations/higgsfield]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_jobs]] · [[../../CLAUDE]]
