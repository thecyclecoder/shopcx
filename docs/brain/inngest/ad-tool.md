# inngest/ad-tool

Ad tool — async generation pipeline (Higgsfield + Whisper + Remotion). One function per stage; every Higgsfield call is logged to `ad_jobs` by the client wrapper for audit/replay.

**File:** `src/lib/inngest/ad-tool.ts` · Registered in `src/app/api/inngest/route.ts` via `adToolFunctions`. See [[../integrations/higgsfield]], [[../libraries/ad-render]].

## Functions

All share `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]` so a single workspace can't monopolize Higgsfield rate limits.

### `ad-tool-face-requested`
- **Trigger:** event `ad-tool/face-requested` (`{ workspace_id, candidate_id, gender, age_range, health_level, ethnicity, context?, variant? }`) · **Retries:** 2
- Generates ONE avatar face: `buildAvatarPortraitPrompt` → `generateSoulPortrait` + poll → uploads to the library path → flips `ad_avatar_candidates` from `generating` → `available` (or `failed` + `error`). **This is why face gen is async** — image gen exceeds the Vercel function budget, so `POST /api/ads/avatars/candidates` inserts `generating` rows + fires N of these events and returns instantly; the UI polls the rows.

### `ad-tool-hero-requested`
- **Trigger:** event `ad-tool/hero-requested` · **Retries:** 2
- Loads campaign + avatar **face** (`reference_image_urls[0]`) + product isolated image → `generateSeedreamCombine([face, product])` (9:16, quality=high, both uploaded to Higgsfield first) + `pollJobUntilDone` → uploads hero → writes `ad_campaigns.hero_image_url` → emits `ad-tool/hero-completed`. Fails the campaign if the avatar has no face or the product has no isolated image.

### `ad-tool-audio-requested`
- **Trigger:** event `ad-tool/audio-requested` · **Retries:** 2
- `generateTtsAudio` from `ad_campaigns.script_text` + `voice_id` → uploads MP3 → writes `ad_campaigns.audio_url` → emits `ad-tool/audio-completed`.

### `ad-tool-talking-head-requested`
- **Trigger:** event `ad-tool/talking-head-requested` · **Retries:** 2
- Requires `hero_image_url` + `audio_url`. `generateSpeakVideo` — **1 clip for a 15s ad, 2 for 30s** (Speak max = 15s/gen) → uploads → emits `ad-tool/talking-head-completed`.

### `ad-tool-broll-requested`
- **Trigger:** event `ad-tool/broll-requested` · **Retries:** 2
- Pulls up to 3 `product_media` sources (lifestyle-first, packshots second; `slot != 'hero'`), picks vibe-eligible motions, runs N parallel `generateDopVideo` → uploads → emits `ad-tool/broll-completed`.

### `ad-tool-render-requested`
- **Trigger:** event `ad-tool/render-requested` · **Retries:** 1
- Sets campaign `status='rendering'`, Whisper-transcribes the audio once (`transcribeWords`), composes the Tier-5 credibility row + ingredient-image map, then `buildCompositionProps` + `renderAdFormat` for **all 4 formats** (Reels MP4, Feed-4:5 MP4, Stories JPG, Feed-4:5 JPG). Inserts one `ad_videos` row per format (siblings linked via `format_variant_of_id`), uploads each render, sets `status='ready'` per row and the campaign to `ready`/`failed`.

## Downstream events sent

`ad-tool/hero-completed` · `ad-tool/audio-completed` · `ad-tool/talking-head-completed` · `ad-tool/broll-completed`

## Tables written

`ad_campaigns` (hero_image_url, audio_url, status), `ad_videos` (one row per format), `ad_jobs` (every Higgsfield call, via the client wrapper).

## Tables read (not written)

`ad_avatars`, `product_variants`, `products`, `product_media`, `product_ad_angles`, `product_ingredients`, `workspaces` (`ad_tool_settings`).

---

[[../README]] · [[../integrations/inngest]] · [[../integrations/higgsfield]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_jobs]] · [[../../CLAUDE]]
