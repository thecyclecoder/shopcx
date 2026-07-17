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

### `ad-tool-broll-requested` (ONE Veo b-roll clip, on demand)
- **Trigger:** event `ad-tool/broll-requested` (`{ workspace_id, campaign_id, mode, prompt?, source_url?, avatar_action?, model? }`) · **Retries:** 1
- Adds **one** b-roll clip at the next seq (appends; doesn't disturb others):
  - `mode="text"`: text-to-video from `prompt` (no source image).
  - `mode="image"`: animate `source_url` (a chosen still) with `prompt` as guiding text.
  - `mode="avatar"`: **animate the campaign's own avatar** doing an [[../libraries/ad-tool-config]] `AVATAR_BROLL_ACTIONS` action (`avatar_action`). Loads the avatar face (+ product isolated image when the action `usesProduct`), builds the action frame via `generateNanoBananaProCombine` (`buildAvatarBrollStill`, identity-locked), uploads it to `broll-stills/`, then animates that still with the action's `motion` prompt. Fails soft (`no_avatar_face`/`no_product_image`/`unknown_avatar_action`).
  - `model`: `fast` (default) | `full` (HQ Veo 3).
- Persists an [[../tables/ad_segments]] row (`kind=broll`, `source_url`, `prompt`). Emits `ad-tool/broll-completed`. **Switched from Higgsfield DoP → Veo** (DoP returned HTTP 422 on this account).
- **B-roll is a "studio", not a staged button**: add clips one at a time (text / animate-photo / **reuse from library**), keep or discard each; the ad renders with ANY count incl. zero (`buildComposition` overlays however many exist). Tailored default prompt: `buildBrollPrompt(productTitle, slot, alt)` (ingredient macros get subtle motion, not pour/sizzle — generic prompts were producing nonsense motion on a mushroom photo).
- Routes: `POST /broll` (add one), `POST /broll/reuse {segId}` (copy a library clip in, no regen), `POST /segments/delete {segId}` (discard = soft `is_active=false`), `GET /api/ads/broll-library` (workspace-wide reusable clips, deduped by file).

### `ad-tool-render-requested`
- **Trigger:** event `ad-tool/render-requested` · **Retries:** 1
- Sets campaign `status='rendering'`. **`assemble` step:** `loadActiveSegments` (talking/broll/music) → **backfills Whisper transcripts** for any talking clip missing them (so captions never come back empty + trims stay tight) → generates a Lyria music bed if missing (persists `kind=music`) → `buildComposition` + `saveComposition` (`ad_campaigns.composition`) → resolves signed URLs → `buildVoCaptions` (per-segment proofread vs script, numbers + `%` preserved). Then renders **all 4 formats**: video via `renderVoSpineVideoTo` (`ExampleAd`), static via `renderStaticTo` (`AdStatic`). One `ad_videos` row per format (siblings via `format_variant_of_id`); `meta.storage_path` stored for re-signing.
- **Render runs on Remotion Lambda in prod** (`REMOTION_RENDER_MODE=lambda`) — Remotion can't run on Vercel serverless. See [[../integrations/remotion-lambda]]. Local dev renders in-process.

### `ad-tool-segment-regenerate` (refresh a beat / upgrade to HQ Veo 3)
- **Trigger:** event `ad-tool/segment-regenerate` (`{ workspace_id, campaign_id, seq, kind?, new_script?, model? }`) · **Retries:** 1
- Regenerates ONE clip at `version+1` (`regenerateSegment`), then fires `ad-tool/render-requested` to re-stitch:
  - `kind=talking_head` (default): with a NEW `new_script` (the re-launch "refresh the hook") or the same script; image = hero; Whisper trim.
  - `kind=broll`: re-animates its stored `source_url`.
  - `model`: `fast` (Veo 3.1 Fast, default) or `full` (Veo 3.1 — slower, higher quality) so a weak clip can be upgraded.
- See [[../recipes/ad-relaunch-refresh]]. Triggered by `POST /api/ads/campaigns/{id}/segments/regenerate` (`{ seq, kind, model, new_script? }`). UI: per-clip "Refresh this hook" / "Regenerate" + "Regenerate in HQ (Veo 3)".

### `ad-tool-static-requested` (static ads — separate process)
- **Trigger:** event `ad-tool/static-requested` (`{ workspace_id, campaign_id, archetype, copy? }`) · **Retries:** 1
- A **distinct** pipeline from video (no talking head/b-roll/music/timeline). The handler **branches on archetype**:
  - **Legacy** (`review`/`offer`/`benefit_authority`): `loadStaticInputs` → PURE `build{Review,Offer,BenefitAuthority}Props` → `StaticReview`/`StaticOffer`/`StaticBenefitAuthority` across **3 formats** (`feed_1x1`/`feed_4x5`/`stories_9x16`).
  - **Killer (cold-50+)** (`advertorial`/`testimonial`/`authority`/`big_claim`/`before_after`): `loadKillerAssets` + `buildKillerStatic` ([[../libraries/ad-statics]], async — generates copy + heroes, fresh signed URLs) → the matching `Static*` composition across **both formats** (`feed_4x5` + `stories_9x16` with safe-zone insets).
  - Both write `ad_videos` rows (`media_kind='static'`, `meta.archetype`, `format_variant_of_id`) via `renderStillCompositionTo`. Route: `POST /api/ads/campaigns/[id]/static`. See [[../lifecycles/ad-static]] + [[../specs/killer-statics]].

### `ad-tool-publish-to-meta` (publish ad to Meta)
- **Trigger:** event `ad-tool/publish-to-meta` (`{ workspace_id, job_id }`) · **Retries:** 1
- Loads the [[../tables/ad_publish_jobs]] row → `uploadAdVideo` (re-signed video `file_url`) → `waitForVideoReady` (poll) → `createAdCreative` (asset_feed_spec copy variants) → `createAd` (**PAUSED** unless `publish_active`) → writes `meta_video_id`/`meta_creative_id`/`meta_ad_id` + `publish_status`. The ad name is `ad_publish_jobs.ad_name` when set (engine-created `[ie]` drafts — Iteration Engine 6b), else the campaign name. Graph v21.0 via [[../libraries/meta-ads]]. **6b write-back:** when the job carries a `recommendation_id`, on publish it flips that [[../tables/iteration_recommendations]] row to `status='executed'` with the meta ids (or `failed`). Routes: `POST /api/ads/campaigns/[id]/publish` (+ `/meta-copy`, `GET /api/ads/meta`); also fired by [[meta-performance]] `meta-execute-recommendation`. See [[../lifecycles/ad-publish]].
- **Multi-variant asset_feed_spec fanout (dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection Phase 1).** The publisher's `baseCreative` builder reads `job.headlines`/`job.primary_texts`/`job.descriptions` (all jsonb string-arrays; `descriptions` nullable — falls back to `[job.description]` when the job is legacy studio / deterministic-mode). All three arrays flow into [[../libraries/meta-ads]] `createAdCreative` / `createDualAssetCreative` / `createPlacementCreative`, which splat them 1:1 into Meta's `asset_feed_spec` `titles[]`/`bodies[]`/`descriptions[]` so a 3-variant temperature-banded pack (`{warm, cold, hot}` from [[../tables/ad_creative_copy_variants]] via `readCopyVariants`) lands as 3 titles + 3 bodies + 3 descriptions that Advantage+ picks per user. A single-caption job produces single-entry `titles[]`/`bodies[]`/`descriptions[]` (byte-identical to today) — no branching on variant count in the publisher; the array shape IS the branch. Pinned in `agent.test.ts` "Phase 1 — meta-ads asset_feed_spec" structural test.
- **Media-buyer test gate + per-test adset (CEO 2026-07-12).** For `origin='media-buyer-test'` jobs the publisher re-checks [[../libraries/media-buyer-publish-gate]] `evaluateMediaBuyerTestPublish` (product-scoped) before creating the ad; a refusal DOWNGRADES `publish_active=false` + escalates to the CEO. When the job carries `create_adset_spec` (a per-test cohort), the publisher gates on the SPEC's budget, then mints a dedicated ~$150/day ad set via `createAdSet` (in `spec.campaign_id`) with the gated status (ACTIVE only if allowed, else PAUSED), stamps `meta_adset_id`, and creates the ad into it — so each test creative gets its own full-budget ad set. Idempotent across retries (a stamped `meta_adset_id` is reused, never re-created). See [[../tables/media_buyer_test_cohorts]] · [[../libraries/provision-cohort]].

### `ad-tool-generate-full` (orchestrator — whole ad, fire-and-forget)
- **Trigger:** event `ad-tool/generate-full` (`{ workspace_id, campaign_id, broll_actions?: string[] }`) · **Retries:** 0 · **Concurrency:** 1 / workspace (a batch serializes so it doesn't burst past Veo's rate cap).
- Chains the stages for one campaign via `step.invoke` (each awaits completion): **hero → talking head → N avatar b-roll** (`mode="avatar"`, one per `broll_actions` value, ≤2) **→ render**. Aborts if hero or talking-head returns `ok:false`; a failed b-roll clip doesn't abort the ad. Used to batch-build a set of ads (e.g. 5 campaigns × varied angle/scene/avatar) without clicking each stage.

## Staging / UI control

Stages are **manual + staged** by default — each fired by its own route from the campaign page's **Production** panel (`/dashboard/marketing/ads/[id]`): `POST /hero`, `/talking-head`, `/broll`, `/music`, `/render` (+ `/segments/regenerate`). The panel shows each stage's state (done/running/ready/blocked) from the DB and lights up the next. Generate in order: hero → talking head → b-roll (optional) → render. An ad rendered before a talking head exists is left in `draft` (recoverable), not `failed`, so it can be resumed and finished. `ad-tool-generate-full` (above) is the fire-and-forget alternative that runs the whole chain for one campaign.

## Downstream events sent

`ad-tool/hero-completed` · `ad-tool/talking-head-completed` · `ad-tool/broll-completed` · `ad-tool/render-requested` (from segment-regenerate)

## Tables written

`ad_campaigns` (hero_image_url, audio_url, **composition**, status), `ad_segments` (talking/broll/music pieces — the creative library), `ad_videos` (one row per format), `ad_jobs` (every Higgsfield call, via the client wrapper), `ad_publish_jobs` (publish status + meta ids), [[../tables/iteration_recommendations]] (6b write-back when `recommendation_id` set).

## Tables read (not written)

`ad_avatars`, `product_variants`, `products`, `product_media`, `product_ad_angles`, `product_ingredients`, `workspaces` (`ad_tool_settings`, `gemini_api_key_encrypted`).

---

[[../README]] · [[../integrations/inngest]] · [[../integrations/higgsfield]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_jobs]] · [[../../CLAUDE]]
