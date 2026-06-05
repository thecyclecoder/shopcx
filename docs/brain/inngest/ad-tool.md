# inngest/ad-tool

Ad tool — async generation pipeline (Gemini Veo/Nano Banana Pro/Lyria + Higgsfield Soul/DoP + Whisper + Remotion). One function per stage; every piece persists to the creative library ([[../tables/ad_segments]]).

**File:** `src/lib/inngest/ad-tool.ts` · Registered in `src/app/api/inngest/route.ts` via `adToolFunctions`. See [[../libraries/gemini]], [[../libraries/ad-segments]], [[../integrations/higgsfield]], [[../libraries/ad-render]].

## Functions

All share `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]` so a single workspace can't monopolize Higgsfield rate limits.

### `ad-tool-face-requested`
- **Trigger:** event `ad-tool/face-requested` (`{ workspace_id, candidate_id, gender, age_range, health_level, ethnicity, context?, variant? }`) · **Retries:** 2
- Generates ONE avatar face: `buildAvatarPortraitPrompt` → `generateSoulPortrait` + poll → uploads to the library path → flips `ad_avatar_candidates` from `generating` → `available` (or `failed` + `error`). **This is why face gen is async** — image gen exceeds the Vercel function budget, so `POST /api/ads/avatars/candidates` inserts `generating` rows + fires N of these events and returns instantly; the UI polls the rows.

### `ad-tool-hero-requested`
- **Trigger:** event `ad-tool/hero-requested` (`{ workspace_id, campaign_id, feedback? }`) · **Retries:** 2
- Loads campaign + avatar **face** (`reference_image_urls[0]`) + product isolated image → `generateNanoBananaProCombine([face, product])` (Gemini, 9:16, synchronous — identity-locked, sharp packaging text) → uploads hero → writes `ad_campaigns.hero_image_url` → emits `ad-tool/hero-completed`. Fails the campaign if the avatar has no face or the product has no isolated image. (Replaced Seedream/Soul combine.)
- **`feedback`** (optional) is a free-text operator correction appended to the prompt on regeneration (e.g. "hands look wrong relative to arms") + a generic anatomy-fix clause. Sent by the Hero card's "Regenerate hero" with a comment.

> **No `audio` (TTS) stage.** The VO is the talking-head Veo clips' native audio; the only added track is the Lyria music bed. The old `ad-tool/audio-requested` function + `/api/ads/campaigns/[id]/audio` route are deleted.

### `ad-tool-music-requested` (Lyria background music)
- **Trigger:** event `ad-tool/music-requested` (`{ workspace_id, campaign_id, prompt? }`) · **Retries:** 1
- `generateLyriaMusic` (optional style `prompt`, else default) → uploads → persists an [[../tables/ad_segments]] row (`kind=music`). Retires the previous active music bed only **after** the new one succeeds (a failed gen leaves the existing bed in place). Emits `ad-tool/music-completed`. Route: `POST /api/ads/campaigns/[id]/music`.
- **Also auto-generated**: the render `assemble` step makes a bed if none is active — so music is optional in the staged flow, but the explicit stage lets the operator generate/preview/regenerate it before rendering.

### `ad-tool-talking-head-requested` (Veo 3.1 Fast, multi-segment, persisted)
- **Trigger:** event `ad-tool/talking-head-requested` · **Retries:** 1
- Requires `hero_image_url`. `splitScriptIntoSegments` → ~8s beats; for each: `generateVeoVideo` (Veo 3.1 Fast, image-to-video from the hero, native audio = VO spine), Whisper sets the trim, persists an [[../tables/ad_segments]] row (`kind=talking_head`, its `script_text` + `transcript_json` + `trim_sec`). Sequential (Veo Fast daily cap). Emits `ad-tool/talking-head-completed`.

### `ad-tool-broll-requested` (Veo 3.1 Fast image-to-video)
- **Trigger:** event `ad-tool/broll-requested` · **Retries:** 1
- Pulls up to 3 `product_media` stills (lifestyle/ingredient first; `slot != 'hero'`), `generateVeoVideo` each (image-to-video, ASMR prompt, muted) → persists an [[../tables/ad_segments]] row (`kind=broll`, with `source_url` = the still). Retires prior b-roll first. Emits `ad-tool/broll-completed`. **Switched from Higgsfield DoP → Veo** (DoP was returning HTTP 422 on this account).

### `ad-tool-render-requested`
- **Trigger:** event `ad-tool/render-requested` · **Retries:** 1
- Sets campaign `status='rendering'`. **`assemble` step:** `loadActiveSegments` (talking/broll/music) → generates a Lyria music bed if missing (persists `kind=music`) → `buildComposition` + `saveComposition` (`ad_campaigns.composition`) → resolves signed URLs → `buildVoCaptions` (per-segment Whisper proofread vs script, numbers + `%` preserved). Then renders **all 4 formats**: video via `renderVoSpineVideo` (canonical `ExampleAd` composition — VO spine + muted/ASMR b-roll + Lyria bed + captions), static via `renderAdFormat` (`AdStatic`). One `ad_videos` row per format (siblings via `format_variant_of_id`).

### `ad-tool-segment-regenerate` (refresh a beat / upgrade to HQ Veo 3)
- **Trigger:** event `ad-tool/segment-regenerate` (`{ workspace_id, campaign_id, seq, kind?, new_script?, model? }`) · **Retries:** 1
- Regenerates ONE clip at `version+1` (`regenerateSegment`), then fires `ad-tool/render-requested` to re-stitch:
  - `kind=talking_head` (default): with a NEW `new_script` (the re-launch "refresh the hook") or the same script; image = hero; Whisper trim.
  - `kind=broll`: re-animates its stored `source_url`.
  - `model`: `fast` (Veo 3.1 Fast, default) or `full` (Veo 3.1 — slower, higher quality) so a weak clip can be upgraded.
- See [[../recipes/ad-relaunch-refresh]]. Triggered by `POST /api/ads/campaigns/{id}/segments/regenerate` (`{ seq, kind, model, new_script? }`). UI: per-clip "Refresh this hook" / "Regenerate" + "Regenerate in HQ (Veo 3)".

## Staging / UI control

Stages are **manual + staged** (no auto-orchestrator), each fired by its own route from the campaign page's **Production** panel (`/dashboard/marketing/ads/[id]`): `POST /hero`, `/talking-head`, `/broll`, `/music`, `/render` (+ `/segments/regenerate`). The panel shows each stage's state (done/running/ready/blocked) from the DB and lights up the next. Generate in order: hero → talking head → b-roll (optional) → render. An ad rendered before a talking head exists is left in `draft` (recoverable), not `failed`, so it can be resumed and finished.

## Downstream events sent

`ad-tool/hero-completed` · `ad-tool/talking-head-completed` · `ad-tool/broll-completed` · `ad-tool/render-requested` (from segment-regenerate)

## Tables written

`ad_campaigns` (hero_image_url, audio_url, **composition**, status), `ad_segments` (talking/broll/music pieces — the creative library), `ad_videos` (one row per format), `ad_jobs` (every Higgsfield call, via the client wrapper).

## Tables read (not written)

`ad_avatars`, `product_variants`, `products`, `product_media`, `product_ad_angles`, `product_ingredients`, `workspaces` (`ad_tool_settings`, `gemini_api_key_encrypted`).

---

[[../README]] · [[../integrations/inngest]] · [[../integrations/higgsfield]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_jobs]] · [[../../CLAUDE]]
